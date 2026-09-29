//! The amount-field expression grammar in `lib/expression.ts`.

pub fn evaluate_expression(input: &str) -> Option<f64> {
    let cleaned: String = input
        .chars()
        .filter(|c| *c != '$' && *c != ',')
        .map(|c| if js_whitespace(c) { ' ' } else { c })
        .collect();
    let mut parser = Parser {
        bytes: cleaned.trim_matches(' ').as_bytes(),
        pos: 0,
    };
    let value = parser.expression()?;
    parser.skip_whitespace();
    (parser.pos == parser.bytes.len() && value.is_finite()).then_some(value)
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000D}' | ' ' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn skip_whitespace(&mut self) {
        while self
            .bytes
            .get(self.pos)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_whitespace();
        self.bytes.get(self.pos).copied()
    }

    fn consume(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.pos += 1;
        Some(byte)
    }

    fn number(&mut self) -> Option<f64> {
        self.skip_whitespace();
        let start = self.pos;
        while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        let integer = self.pos > start;
        let mut fractional = false;
        if self.bytes.get(self.pos) == Some(&b'.') {
            self.pos += 1;
            let decimal_start = self.pos;
            while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                self.pos += 1;
            }
            fractional = self.pos > decimal_start;
            if !fractional {
                return None;
            }
        }
        if !integer && !fractional {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .ok()?
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
    }

    fn factor(&mut self) -> Option<f64> {
        match self.peek()? {
            b'-' => {
                self.consume();
                Some(-self.factor()?)
            }
            b'(' => {
                self.consume();
                let value = self.expression()?;
                (self.consume()? == b')').then_some(value)
            }
            _ => self.number(),
        }
    }

    fn term(&mut self) -> Option<f64> {
        let mut left = self.factor()?;
        loop {
            match self.peek() {
                Some(b'*') => {
                    self.consume();
                    left *= self.factor()?;
                }
                Some(b'/') => {
                    self.consume();
                    let right = self.factor()?;
                    if right == 0.0 {
                        return None;
                    }
                    left /= right;
                }
                _ => return Some(left),
            }
        }
    }

    fn expression(&mut self) -> Option<f64> {
        let mut left = self.term()?;
        loop {
            match self.peek() {
                Some(b'+') => {
                    self.consume();
                    left += self.term()?;
                }
                Some(b'-') => {
                    self.consume();
                    left -= self.term()?;
                }
                _ => return Some(left),
            }
        }
    }
}
