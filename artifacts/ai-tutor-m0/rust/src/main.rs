use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};
use ts_rs::TS;

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    code: String,
    expected: Verdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
enum Verdict {
    Checked,
    Unchecked,
    Missing,
    Unknown,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
struct SliceRange {
    start_utf16: u32,
    end_utf16: u32,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
struct ResultRow {
    id: String,
    verdict: Verdict,
    parser_has_error: bool,
    call_count: u32,
    source_range: Option<SliceRange>,
}

fn nodes<'a>(node: Node<'a>, out: &mut Vec<Node<'a>>) {
    out.push(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        nodes(child, out);
    }
}
fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}
fn norm(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}
fn within_if_comparison(call: Node<'_>, source: &str) -> bool {
    let mut parent = call.parent();
    while let Some(p) = parent {
        if p.kind() == "if_statement" {
            return p.child_by_field_name("condition").is_some_and(|c| {
                let expression = norm(text(c, source));
                let call_text = norm(text(call, source));
                [
                    format!("({call_text}!=HAL_OK)"),
                    format!("(HAL_OK!={call_text})"),
                    format!("({call_text}==HAL_OK)"),
                    format!("(HAL_OK=={call_text})"),
                ]
                .contains(&expression)
            });
        }
        if matches!(
            p.kind(),
            "expression_statement" | "declaration" | "return_statement" | "compound_statement"
        ) {
            break;
        }
        parent = p.parent();
    }
    false
}
fn assigned_guard(call: Node<'_>, source: &str) -> bool {
    let Some(init) = call.parent().filter(|n| n.kind() == "init_declarator") else {
        return false;
    };
    let Some(name) = init
        .child_by_field_name("declarator")
        .filter(|n| n.kind() == "identifier")
    else {
        return false;
    };
    let Some(decl) = init.parent().filter(|n| n.kind() == "declaration") else {
        return false;
    };
    let Some(guard) = decl
        .next_named_sibling()
        .filter(|n| n.kind() == "if_statement")
    else {
        return false;
    };
    guard.child_by_field_name("condition").is_some_and(|c| {
        let name = text(name, source);
        let expression = norm(text(c, source));
        [
            format!("({name}!=HAL_OK)"),
            format!("(HAL_OK!={name})"),
            format!("({name}==HAL_OK)"),
            format!("(HAL_OK=={name})"),
        ]
        .contains(&expression)
    })
}
fn inspect(parser: &mut Parser, case: &Case) -> ResultRow {
    let tree = parser.parse(&case.code, None).expect("parse cancelled");
    let root = tree.root_node();
    let mut all = Vec::new();
    nodes(root, &mut all);
    let calls: Vec<_> = all
        .iter()
        .copied()
        .filter(|n| {
            n.kind() == "call_expression"
                && n.child_by_field_name("function")
                    .is_some_and(|f| f.kind() == "identifier" && text(f, &case.code) == "receive")
        })
        .collect();
    let unsupported = root.has_error()
        || all.iter().any(|n| {
            n.kind().starts_with("preproc_")
                || (n.kind() == "pointer_declarator"
                    && n.parent()
                        .is_some_and(|p| p.kind() == "parenthesized_declarator"))
        });
    let verdict = if unsupported {
        Verdict::Unknown
    } else if calls.is_empty() {
        Verdict::Missing
    } else if calls.iter().any(|c| {
        c.parent()
            .is_some_and(|p| p.kind() == "expression_statement")
    }) {
        Verdict::Unchecked
    } else if calls
        .iter()
        .all(|c| within_if_comparison(*c, &case.code) || assigned_guard(*c, &case.code))
    {
        Verdict::Checked
    } else {
        Verdict::Unknown
    };
    let source_range = calls.first().map(|c| SliceRange {
        start_utf16: case.code[..c.start_byte()].encode_utf16().count() as u32,
        end_utf16: case.code[..c.end_byte()].encode_utf16().count() as u32,
    });
    ResultRow {
        id: case.id.clone(),
        verdict,
        parser_has_error: root.has_error(),
        call_count: calls.len() as u32,
        source_range,
    }
}
fn main() {
    let mut parser = Parser::new();
    let language = tree_sitter_c::LANGUAGE.into();
    parser.set_language(&language).expect("grammar ABI");
    let cases: Vec<Case> = serde_json::from_str(include_str!("../fixtures.json")).unwrap();
    let rows: Vec<_> = cases.iter().map(|c| inspect(&mut parser, c)).collect();
    for (case, row) in cases.iter().zip(&rows) {
        assert_eq!(case.expected, row.verdict, "{}", case.id);
    }
    let utf = cases.iter().find(|c| c.id == "utf8-label").unwrap();
    let row = rows.iter().find(|r| r.id == utf.id).unwrap();
    let start = row.source_range.as_ref().unwrap().start_utf16 as usize;
    assert_eq!(
        String::from_utf16(
            &utf.code
                .encode_utf16()
                .skip(start)
                .take(7)
                .collect::<Vec<_>>()
        )
        .unwrap(),
        "receive"
    );
    let declarations = format!(
        "{}\n{}\n{}\n",
        Verdict::decl(),
        SliceRange::decl(),
        ResultRow::decl()
    );
    assert!(declarations.contains("startUtf16") && declarations.contains("parserHasError"));
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"treeSitter":"0.27.1","grammar":"0.24.2","grammarAbi":language.abi_version(),"tsRs":"11.1.0","cases":rows,"typescript":declarations,"meaning":"checked confirms only bounded syntactic observation; never semantic or course completion"})).unwrap());
}
