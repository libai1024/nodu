// SPDX-License-Identifier: MIT
//! Minimal `repr`/`ast.literal_eval` subset used to decode values the board
//! prints back (`print(repr(...))`): tuples, lists, ints, bools, `None`,
//! strings and byte strings. Anything outside this subset is a parse error.

#[derive(Debug, Clone, PartialEq)]
pub enum PyValue {
    None,
    Bool(bool),
    Int(i64),
    Str(String),
    Bytes(Vec<u8>),
    List(Vec<PyValue>),
    Tuple(Vec<PyValue>),
}

impl PyValue {
    pub fn as_bytes(&self) -> Option<&[u8]> {
        if let Self::Bytes(b) = self {
            Some(b)
        } else {
            None
        }
    }
    pub fn as_tuple(&self) -> Option<&[PyValue]> {
        if let Self::Tuple(t) = self {
            Some(t)
        } else {
            None
        }
    }
    pub fn as_int(&self) -> Option<i64> {
        if let Self::Int(i) = self {
            Some(*i)
        } else {
            None
        }
    }
}

pub fn parse(text: &str) -> Result<PyValue, String> {
    let mut p = Parser {
        chars: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.pos != p.chars.len() {
        return Err(format!("trailing data at offset {}", p.pos));
    }
    Ok(v)
}

struct Parser<'a> {
    chars: &'a [u8],
    pos: usize,
    depth: usize,
}

const MAX_DEPTH: usize = 64;

impl Parser<'_> {
    fn ws(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.chars.get(self.pos).copied()
    }

    fn value(&mut self) -> Result<PyValue, String> {
        self.ws();
        match self.peek() {
            Some(b'(') => self.seq(b'(', b')').map(PyValue::Tuple),
            Some(b'[') => self.seq(b'[', b']').map(PyValue::List),
            Some(b'\'' | b'"') => self
                .string()
                .map(|b| PyValue::Str(String::from_utf8_lossy(&b).into_owned())),
            Some(b'b') if matches!(self.chars.get(self.pos + 1), Some(b'\'' | b'"')) => {
                self.pos += 1;
                self.string().map(PyValue::Bytes)
            }
            Some(b'T') => self.keyword(b"True").map(|()| PyValue::Bool(true)),
            Some(b'F') => self.keyword(b"False").map(|()| PyValue::Bool(false)),
            Some(b'N') => self.keyword(b"None").map(|()| PyValue::None),
            Some(b'-' | b'0'..=b'9') => self.int().map(PyValue::Int),
            other => Err(format!(
                "unexpected character {other:?} at offset {}",
                self.pos
            )),
        }
    }

    fn keyword(&mut self, kw: &[u8]) -> Result<(), String> {
        if self.chars[self.pos..].starts_with(kw) {
            self.pos += kw.len();
            Ok(())
        } else {
            Err(format!("bad literal at offset {}", self.pos))
        }
    }

    fn int(&mut self) -> Result<i64, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.chars[start..self.pos]).unwrap_or("0");
        text.parse().map_err(|_| format!("bad integer {text:?}"))
    }

    fn seq(&mut self, open: u8, close: u8) -> Result<Vec<PyValue>, String> {
        debug_assert_eq!(self.peek(), Some(open));
        if self.depth >= MAX_DEPTH {
            return Err("sequence nested too deeply".into());
        }
        self.depth += 1;
        let result = self.seq_inner(close);
        if result.is_ok() {
            self.depth -= 1;
        }
        result
    }

    fn seq_inner(&mut self, close: u8) -> Result<Vec<PyValue>, String> {
        self.pos += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(close) {
            self.pos += 1;
            return Ok(items);
        }
        // First item; a leading comma rejects below in value().
        items.push(self.value()?);
        loop {
            self.ws();
            match self.peek() {
                None => return Err("unterminated sequence".into()),
                Some(c) if c == close => {
                    self.pos += 1;
                    return Ok(items);
                }
                Some(b',') => {
                    // A comma must be followed by another value or the close.
                    // `[,,]`, `(1,,)` and `(1 2)` all reject.
                    self.pos += 1;
                    self.ws();
                    match self.peek() {
                        None => return Err("unterminated sequence".into()),
                        Some(c) if c == close => {
                            self.pos += 1;
                            return Ok(items);
                        }
                        Some(b',') => return Err("empty item in sequence".into()),
                        _ => items.push(self.value()?),
                    }
                }
                // Adjacent values without a comma are malformed.
                _ => return Err("missing comma in sequence".into()),
            }
        }
    }

    fn string(&mut self) -> Result<Vec<u8>, String> {
        let quote = self.peek().ok_or("eof")?;
        self.pos += 1;
        let mut out = Vec::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            self.pos += 1;
            match c {
                c if c == quote => return Ok(out),
                b'\\' => {
                    let e = self.peek().ok_or("unterminated escape")?;
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'\\' => out.push(b'\\'),
                        b'\'' => out.push(b'\''),
                        b'"' => out.push(b'"'),
                        b'0' => out.push(0),
                        b'x' => {
                            if self.pos + 2 > self.chars.len() {
                                return Err("short hex escape".into());
                            }
                            let hex = std::str::from_utf8(&self.chars[self.pos..self.pos + 2])
                                .map_err(|_| "bad hex escape")?;
                            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad hex escape")?);
                            self.pos += 2;
                        }
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
    }
}

#[cfg(test)]
mod strictness_tests {
    use super::*;

    #[test]
    fn nested_over_64_fails() {
        let deep = "[".repeat(70) + "1" + &"]".repeat(70);
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn malformed_lists_fail() {
        for bad in ["(1 2)", "[,,]", "[1,,2]", "[,]", "[1,2", "[]extra"] {
            assert!(parse(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn nested_normal_ok() {
        let PyValue::List(items) = parse("[1,(2,[3]),(4,5)]").unwrap() else {
            panic!("expected list")
        };
        assert_eq!(items.len(), 3);
        let PyValue::Tuple(pair) = parse("(1,2,)").unwrap() else {
            panic!("expected tuple")
        };
        assert_eq!(pair.len(), 2); // trailing comma ok
    }
}
