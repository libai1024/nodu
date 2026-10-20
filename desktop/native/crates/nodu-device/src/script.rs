// SPDX-License-Identifier: MIT
// Ported from openmv/qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032:src/plugins/openmv/openmvplugin.cpp (MIT).
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvplugin.cpp (loadFilter)
// Safe replacement for the regex-based `loadFilter` in the pinned OpenMV
// plugin (openmv-qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032:
// src/plugins/openmv/openmvplugin.cpp loadFilter, ~line 6538). The original
// regexes could strip `#` inside multiline string literals and rewrite
// whitespace globally. This byte-state scanner only removes `#` comments that
// start outside a string literal, and only converts *leading* indentation on
// code lines; it refuses ambiguous indentation instead of guessing.

/// Match the Node-side 256 KiB script cap.
pub const MAX_CODE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StringState {
    None,
    Single,
    Double,
    TripleSingle,
    TripleDouble,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IndentStyle {
    /// At least one code line indented with tabs only.
    Tabs,
    /// At least one code line indented with spaces only.
    Spaces,
}

fn err(message: impl Into<String>) -> Result<String, String> {
    Err(message.into())
}

fn trim_padding(out: &mut Vec<u8>) {
    while matches!(out.last(), Some(b' ' | b'\t')) {
        out.pop();
    }
}

/// Format a Python buffer: optionally strip `#` comments and/or convert
/// 4-space leading indentation to tabs. With stripping enabled,
/// comment-only and blank physical lines outside string literals are
/// removed entirely (like the original `loadFilter`), and whitespace
/// padding left by removed comments is trimmed. String literal contents —
/// including their newlines and indentation — are never touched; the line
/// endings of retained lines (`\n` or `\r\n`) are preserved verbatim.
pub fn format(code: &str, strip_comments: bool, spaces_to_tabs: bool) -> Result<String, String> {
    if code.len() > MAX_CODE_BYTES {
        return err("Script exceeds the 256 KiB limit.");
    }
    if !strip_comments && !spaces_to_tabs {
        return Ok(code.to_string());
    }
    let bytes = code.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut state = StringState::None;
    let mut indent_style: Option<IndentStyle> = None;
    let mut i = 0usize;
    // A line start only exists when we are not inside a string literal.
    let mut line_start = true;

    while i < bytes.len() {
        let b = bytes[i];
        match state {
            StringState::None => {
                if line_start {
                    // Leading indentation of this physical line.
                    let mut j = i;
                    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                        j += 1;
                    }
                    let indent = &bytes[i..j];
                    let blank = j >= bytes.len()
                        || bytes[j] == b'\n'
                        || (bytes[j] == b'\r' && bytes.get(j + 1) == Some(&b'\n'));
                    // Stripping removes blank and comment-only physical
                    // lines entirely (CRLF included); they never take part
                    // in indent checks or reach the output.
                    if strip_comments && (blank || bytes.get(j) == Some(&b'#')) {
                        while j < bytes.len() && bytes[j] != b'\n' {
                            j += 1;
                        }
                        if j < bytes.len() {
                            j += 1; // consume the LF
                        }
                        i = j;
                        line_start = true;
                        continue;
                    }
                    // Comment-only lines do not take part in indent-style or
                    // multiple-of-4 checks; when stripping is off they pass
                    // through untouched.
                    if !indent.is_empty() && !blank && bytes[j] != b'#' {
                        let has_space = indent.contains(&b' ');
                        let has_tab = indent.contains(&b'\t');
                        if spaces_to_tabs && has_space && has_tab {
                            return err("缩进混用空格与制表符，已取消缩进转换；脚本保持不变。");
                        }
                        if spaces_to_tabs && has_space && !indent.len().is_multiple_of(4) {
                            return err(
                                "代码行缩进空格数不是 4 的倍数，已取消缩进转换；脚本保持不变。",
                            );
                        }
                        if spaces_to_tabs {
                            let style = if has_tab {
                                IndentStyle::Tabs
                            } else {
                                IndentStyle::Spaces
                            };
                            match indent_style {
                                Some(s) if s != style => {
                                    return err(
                                        "文件同时存在空格缩进与制表符缩进的代码行，已取消缩进转换；脚本保持不变。",
                                    );
                                }
                                _ => indent_style = Some(style),
                            }
                            if style == IndentStyle::Spaces {
                                out.resize(out.len() + indent.len() / 4, b'\t');
                                i = j;
                                line_start = false;
                                continue;
                            }
                        }
                    }
                    // Emit the indentation verbatim (blank lines, tab indent,
                    // or no conversion requested).
                    out.extend_from_slice(indent);
                    i = j;
                    line_start = false;
                    continue;
                }
                match b {
                    // `#` starts a comment regardless of string state; quotes
                    // inside comments must never open a literal. Strip or copy
                    // through (not including) the newline; keep a \r\n pair.
                    b'#' => {
                        let mut j = i;
                        while j < bytes.len() && bytes[j] != b'\n' {
                            if bytes[j] == b'\r' && bytes.get(j + 1) == Some(&b'\n') {
                                break;
                            }
                            j += 1;
                        }
                        if strip_comments {
                            trim_padding(&mut out);
                        } else {
                            out.extend_from_slice(&bytes[i..j]);
                        }
                        i = j;
                    }
                    b'\'' | b'"' => {
                        state = if b == b'\''
                            && bytes.get(i + 1) == Some(&b'\'')
                            && bytes.get(i + 2) == Some(&b'\'')
                        {
                            StringState::TripleSingle
                        } else if b == b'"'
                            && bytes.get(i + 1) == Some(&b'"')
                            && bytes.get(i + 2) == Some(&b'"')
                        {
                            StringState::TripleDouble
                        } else if b == b'\'' {
                            StringState::Single
                        } else {
                            StringState::Double
                        };
                        let skip = match state {
                            StringState::TripleSingle | StringState::TripleDouble => 3,
                            _ => 1,
                        };
                        out.extend_from_slice(&bytes[i..i + skip]);
                        i += skip;
                    }
                    b'\n' => {
                        if strip_comments {
                            let cr = out.last() == Some(&b'\r');
                            if cr {
                                out.pop();
                            }
                            trim_padding(&mut out);
                            if cr {
                                out.push(b'\r');
                            }
                        }
                        out.push(b'\n');
                        i += 1;
                        line_start = true;
                    }
                    _ => {
                        out.push(b);
                        i += 1;
                    }
                }
            }
            StringState::Single | StringState::Double => {
                let quote = if state == StringState::Single {
                    b'\''
                } else {
                    b'"'
                };
                out.push(b);
                i += 1;
                if b == b'\\' && i < bytes.len() {
                    out.push(bytes[i]);
                    i += 1;
                } else if b == quote {
                    state = StringState::None;
                }
            }
            StringState::TripleSingle | StringState::TripleDouble => {
                let quote = if state == StringState::TripleSingle {
                    b'\''
                } else {
                    b'"'
                };
                if b == b'\\' && i + 1 < bytes.len() {
                    out.extend_from_slice(&bytes[i..i + 2]);
                    i += 2;
                } else if b == quote
                    && bytes.get(i + 1) == Some(&quote)
                    && bytes.get(i + 2) == Some(&quote)
                {
                    out.extend_from_slice(&bytes[i..i + 3]);
                    i += 3;
                    state = StringState::None;
                } else {
                    out.push(b);
                    i += 1;
                }
            }
        }
    }
    if strip_comments && state == StringState::None {
        trim_padding(&mut out);
    }
    // `out` only ever holds copied input bytes plus tabs, so it stays UTF-8;
    // surface an error instead of silently returning an empty script.
    String::from_utf8(out).map_err(|_| "脚本格式化产物不是有效 UTF-8。".to_string())
}

#[cfg(test)]
mod tests {
    use super::format;

    #[test]
    fn frozen_original_boot_format_comparison() {
        // Frozen original-IDE result: artifacts/delivery-0.1.4/
        // original-boot-formatted-readback.json produced 76 bytes; the
        // untouched variant preserved 182.
        let code = "# Nodu boot formatting comparison.\ndef message():\n    # This comment should disappear only in the formatted variant.\n    return \"NODU_ORIGINAL_BOOT_PROOF_20261021\"\n\nprint(message())\n";
        assert_eq!(
            format(code, true, true).unwrap(),
            "def message():\n\treturn \"NODU_ORIGINAL_BOOT_PROOF_20261021\"\nprint(message())\n"
        );
    }

    #[test]
    fn multiline_string_content_survives_stripping() {
        let code = "s = '''a\n\n    \n# literal\nb'''\n\nx=1 # c\n";
        assert_eq!(
            format(code, true, false).unwrap(),
            "s = '''a\n\n    \n# literal\nb'''\nx=1\n"
        );
    }

    #[test]
    fn both_flags_false_is_identity() {
        let code = "x = 1  # keep me\n    y = '#str'\n";
        assert_eq!(format(code, false, false).unwrap(), code);
    }

    #[test]
    fn inline_comment_stripped_newline_kept() {
        let code = "x = 1  # comment\ny = 2\n";
        assert_eq!(format(code, true, false).unwrap(), "x = 1\ny = 2\n");
    }

    #[test]
    fn hash_inside_strings_preserved() {
        let code = "a = '#no'  # yes\nb = \"#no\"\n";
        assert_eq!(
            format(code, true, false).unwrap(),
            "a = '#no'\nb = \"#no\"\n"
        );
    }

    #[test]
    fn escaped_quote_and_backslash_do_not_open_comment() {
        let code = "a = 'it\\'# still string'  # real\nb = \"x\\\\\" # tail\n";
        assert_eq!(
            format(code, true, false).unwrap(),
            "a = 'it\\'# still string'\nb = \"x\\\\\"\n"
        );
    }

    #[test]
    fn triple_string_spanning_lines_with_hash_preserved() {
        let code = "s = '''\n# not a comment\n    spaces stay\n'''\n";
        assert_eq!(format(code, true, true).unwrap(), code);
    }

    #[test]
    fn unicode_passes_through() {
        let code = "# 注释\ns = '中文 # 保留'\n";
        assert_eq!(format(code, true, false).unwrap(), "s = '中文 # 保留'\n");
    }

    #[test]
    fn comment_at_eof_without_newline() {
        let code = "x = 1 # tail";
        assert_eq!(format(code, true, false).unwrap(), "x = 1");
    }

    #[test]
    fn crlf_preserved() {
        let code = "x = 1\r\n    y = 2\r\n# gone\r\nz = 3\r\n";
        assert_eq!(
            format(code, true, false).unwrap(),
            "x = 1\r\n    y = 2\r\nz = 3\r\n"
        );
        assert_eq!(format(code, false, false).unwrap(), code);
    }

    #[test]
    fn four_and_eight_space_indent_convert_to_tabs() {
        let code = "def f():\n    x = 1\n        y = 2\nz = 0\n";
        assert_eq!(
            format(code, false, true).unwrap(),
            "def f():\n\tx = 1\n\t\ty = 2\nz = 0\n"
        );
    }

    #[test]
    fn spaces_inside_string_not_converted() {
        let code = "s = '    four spaces'\n";
        assert_eq!(format(code, false, true).unwrap(), code);
    }

    #[test]
    fn mixed_tab_space_indent_rejected() {
        let code = "def f():\n \tx = 1\n";
        assert!(format(code, false, true).is_err());
        // Untouched when conversion not requested.
        assert_eq!(format(code, true, false).unwrap(), code);
    }

    #[test]
    fn non_multiple_of_four_indent_rejected() {
        let code = "def f():\n     x = 1\n";
        assert!(format(code, false, true).is_err());
    }

    #[test]
    fn mixed_file_indent_styles_rejected() {
        let code = "def f():\n    a = 1\n\tb = 2\n";
        assert!(format(code, false, true).is_err());
    }

    #[test]
    fn tab_only_indent_untouched() {
        let code = "def f():\n\tx = 1\n";
        assert_eq!(format(code, false, true).unwrap(), code);
    }

    #[test]
    fn oversize_rejected() {
        let code = "a".repeat(super::MAX_CODE_BYTES + 1);
        assert!(format(&code, false, true).is_err());
    }

    #[test]
    fn comment_quote_does_not_shadow_indent_conversion() {
        // strip_comments=false must still lex comments: a lone quote inside a
        // comment must not open a string state for the following code lines.
        let code = "# unmatched '\n    x=1\n";
        assert_eq!(format(code, false, true).unwrap(), "# unmatched '\n\tx=1\n");
    }

    #[test]
    fn comment_only_line_is_not_code_indent() {
        // A 2-space indented comment line must not trip the multiple-of-4 or
        // style checks; the whole physical line is removed by the strip.
        let code = "  # comment\n    x=1\n";
        assert_eq!(format(code, true, true).unwrap(), "\tx=1\n");
        // Tab-indented comment lines do not set the file style either.
        let code = "\t# c\n    x=1\n";
        assert_eq!(format(code, true, true).unwrap(), "\tx=1\n");
    }

    #[test]
    fn comment_only_line_does_not_break_mixed_detection() {
        // Comments between differently-indented code lines are ignored, but the
        // code-line style mix itself is still rejected.
        let code = "    # c\n    a=1\n\tb=2\n";
        assert!(format(code, false, true).is_err());
    }
}
