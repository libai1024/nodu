// SPDX-License-Identifier: MIT
//! Snapshot-only C structure checks. No filesystem, compiler, device or network access.
use std::ops::ControlFlow;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tree_sitter::{Node, ParseOptions, Parser};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub source: String,
    #[serde(default)]
    pub rules: Vec<Rule>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub kind: Kind,
    pub function: String,
    pub callee: String,
}
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind { Calls, NoCallIn, ChecksReturn }
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict { Verified, NeedsWork, Unknown }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding { pub id: String, pub verdict: Verdict, pub line: Option<usize>, pub note: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: u8,
    pub source_digest: String,
    pub syntax: &'static str,
    pub error_lines: Vec<usize>,
    pub findings: Vec<Finding>,
}
fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().enumerate().all(|(i,c)| c.is_ascii_alphabetic() || c == '_' || i > 0 && c.is_ascii_digit())
}
fn text<'s>(n: Node<'_>, source: &'s str) -> &'s str { &source[n.byte_range()] }
fn nodes(root: Node<'_>) -> Result<Vec<Node<'_>>, String> {
    let mut stack = vec![root]; let mut result = Vec::new();
    while let Some(n) = stack.pop() {
        if result.len() >= 20000 { return Err("语法树超过检查预算".into()); }
        result.push(n);
        let mut cursor = n.walk(); stack.extend(n.named_children(&mut cursor));
    }
    Ok(result)
}
fn function_name(node: Node<'_>, source: &str) -> Option<String> {
    let mut n = node.child_by_field_name("declarator")?;
    for _ in 0..12 {
        if n.kind() == "identifier" { return Some(text(n, source).into()); }
        n = n.child_by_field_name("declarator")?;
    }
    None
}
fn comparable(n: Node<'_>, call: &str, source: &str) -> bool {
    let expression: String = text(n, source).chars().filter(|c| !c.is_whitespace()).collect();
    [format!("({call}!=HAL_OK)"),format!("(HAL_OK!={call})"),format!("({call}==HAL_OK)"),format!("(HAL_OK=={call})")].contains(&expression)
}
fn guarded(call: Node<'_>, source: &str) -> bool {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "if_statement" {
            let compact: String = text(call, source).chars().filter(|c| !c.is_whitespace()).collect();
            return n.child_by_field_name("condition").is_some_and(|c| comparable(c, &compact, source));
        }
        if ["expression_statement","declaration","compound_statement","return_statement"].contains(&n.kind()) { break; }
        parent = n.parent();
    }
    let Some(init) = call.parent().filter(|n| n.kind() == "init_declarator") else { return false; };
    let Some(name) = init.child_by_field_name("declarator").filter(|n| n.kind() == "identifier") else { return false; };
    let Some(decl) = init.parent().filter(|n| n.kind() == "declaration" && n.named_child_count() == 2) else { return false; };
    let Some(guard) = decl.next_named_sibling().filter(|n| n.kind() == "if_statement") else { return false; };
    guard.child_by_field_name("condition").is_some_and(|c| comparable(c, text(name, source), source))
}
pub fn inspect(request: &Request) -> Result<Report, String> {
    if request.source.len() > 96000 || request.source.encode_utf16().count() > 32000 || request.source.contains('\0') || request.rules.len() > 32
        || request.rules.iter().any(|r| !valid_name(&r.function) || !valid_name(&r.callee) || r.id.is_empty() || r.id.len() > 80) { return Err("检查请求超过限制".into()); }
    let mut parser = Parser::new(); parser.set_language(&tree_sitter_c::LANGUAGE.into()).map_err(|_| "C语法解析器不可用")?;
    let start = Instant::now();
    let mut budget = |_: &tree_sitter::ParseState| if start.elapsed() > Duration::from_millis(150) { ControlFlow::Break(()) } else { ControlFlow::Continue(()) };
    let source = request.source.as_bytes();
    let tree = parser.parse_with_options(&mut |offset,_| &source[offset..], None, Some(ParseOptions::new().progress_callback(&mut budget))).ok_or("语法检查超时")?;
    let all = nodes(tree.root_node())?;
    let error_lines: Vec<_> = all.iter().filter(|n| n.is_error() || n.is_missing()).take(16).map(|n| n.start_position().row + 1).collect();
    let syntax = if tree.root_node().has_error() { "incomplete" } else { "valid" };
    let macros = all.iter().any(|n| matches!(n.kind(), "preproc_def" | "preproc_function_def" | "preproc_if" | "preproc_ifdef"));
    let mut findings = Vec::new();
    for rule in &request.rules {
        let functions: Vec<_> = all.iter().filter(|n| n.kind() == "function_definition" && function_name(**n, &request.source).as_deref() == Some(&rule.function)).collect();
        let mut finding = Finding { id: rule.id.clone(), verdict: Verdict::Unknown, line: None, note: "作用域不唯一或依赖预处理".into() };
        if functions.len() != 1 || syntax != "valid" || macros { findings.push(finding); continue; }
        let body = nodes(**functions.first().unwrap())?;
        if body.iter().filter(|n| n.kind() == "function_definition").count() != 1 {
            finding.note = "嵌套函数需要独立作用域检查".into(); findings.push(finding); continue;
        }
        let calls: Vec<_> = body.iter().filter(|n| n.kind() == "call_expression" && n.child_by_field_name("function").is_some_and(|f| f.kind() == "identifier" && text(f, &request.source) == rule.callee)).collect();
        finding.line = calls.first().map(|n| n.start_position().row + 1);
        let indirect = body.iter().any(|n| n.kind() == "call_expression" && n.child_by_field_name("function").is_some_and(|f| f.kind() != "identifier"));
        // Syntactic occurrence only: it is not proof of runtime reachability or linked symbol identity.
        finding.verdict = match rule.kind {
            Kind::Calls if !calls.is_empty() => Verdict::Verified,
            Kind::Calls if indirect => Verdict::Unknown,
            Kind::Calls => Verdict::NeedsWork,
            Kind::NoCallIn if !calls.is_empty() => Verdict::NeedsWork,
            Kind::NoCallIn if indirect => Verdict::Unknown,
            Kind::NoCallIn => Verdict::Verified,
            Kind::ChecksReturn if calls.is_empty() => Verdict::Unknown,
            Kind::ChecksReturn if calls.iter().all(|n| guarded(**n, &request.source)) => Verdict::Verified,
            Kind::ChecksReturn if calls.iter().any(|n| n.parent().is_some_and(|p| p.kind() == "expression_statement")) => Verdict::NeedsWork,
            Kind::ChecksReturn => Verdict::Unknown,
        };
        finding.note = match finding.verdict { Verdict::Verified => "符合此项语法结构规则（不代表编译或运行）", Verdict::NeedsWork => "未满足此项直接调用规则", Verdict::Unknown => "需要更多作用域或数据流信息" }.into();
        findings.push(finding);
    }
    Ok(Report { schema: 1, source_digest: format!("{:x}", Sha256::digest(source)), syntax, error_lines, findings })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result(source: &str, kind: Kind) -> Report { inspect(&Request { source: source.into(), rules: vec![Rule { id: "r".into(), kind, function: "main".into(), callee: "receive".into() }] }).unwrap() }
    #[test] fn direct_calls_ignore_comments_strings_and_other_functions() {
        assert_eq!(result("void main(){ receive(); }",Kind::Calls).findings[0].verdict,Verdict::Verified);
        assert_eq!(result("void other(){receive();} void main(){/*receive();*/char*s=\"receive()\";}",Kind::Calls).findings[0].verdict,Verdict::NeedsWork);
    }
    #[test] fn incomplete_and_preprocessor_are_unknown() {
        assert_eq!(result("void main(){receive(",Kind::Calls).syntax,"incomplete");
        assert_eq!(result("#define receive() 0\nvoid main(){ receive(); }",Kind::Calls).findings[0].verdict,Verdict::Unknown);
    }
    #[test] fn guards_and_equivalent_operand_order() {
        for code in ["void main(){if(receive()!=HAL_OK){return;}}", "void main(){if(HAL_OK==receive()){return;}}", "void main(){int rc=receive();if(rc!=HAL_OK){return;}}"] {
            assert_eq!(result(code,Kind::ChecksReturn).findings[0].verdict,Verdict::Verified, "{code}");
        }
        assert_eq!(result("void main(){receive();}",Kind::ChecksReturn).findings[0].verdict,Verdict::NeedsWork);
        assert_eq!(result("void main(){int rc=receive();rc=0;if(rc==HAL_OK){return;}}",Kind::ChecksReturn).findings[0].verdict,Verdict::Unknown);
    }
    #[test] fn restricted_scope_and_indirection() {
        assert_eq!(result("void main(){void nested(){receive();}}",Kind::Calls).findings[0].verdict,Verdict::Unknown);
        assert_eq!(result("void main(){(*fn)();}",Kind::NoCallIn).findings[0].verdict,Verdict::Unknown);
        assert_eq!(result("void other(){receive();} void main(){}",Kind::NoCallIn).findings[0].verdict,Verdict::Verified);
    }
    #[test] fn budget_and_unicode() {
        assert!(inspect(&Request { source: " ".repeat(32001), rules: vec![] }).is_err());
        let r=result("// 汉字😀\nvoid main(){receive();}",Kind::Calls);assert_eq!(r.findings[0].line,Some(2));
    }
}
