/**
 * Evaluates a simple math expression string.
 * Supports: +, -, *, /, parentheses, decimals, negative numbers.
 * Returns the numeric result, or null if the input is not a valid expression.
 *
 * Grammar:
 *   expr   → term (('+' | '-') term)*
 *   term   → factor (('*' | '/') factor)*
 *   factor → '-' factor | '(' expr ')' | number
 *   number → [0-9]+ ('.' [0-9]+)? | '.' [0-9]+
 */
export function evaluateExpression(input: string): number | null {
  // Strip currency symbols, commas, and whitespace-only decorations
  const cleaned = input.replace(/[$,]/g, "").trim();
  if (cleaned.length === 0) return null;

  let pos = 0;

  function peek(): string {
    skipWhitespace();
    return cleaned[pos] ?? "";
  }

  function consume(expected?: string): string {
    skipWhitespace();
    const ch = cleaned[pos];
    if (expected !== undefined && ch !== expected) {
      throw new Error("unexpected");
    }
    pos++;
    return ch;
  }

  function skipWhitespace(): void {
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) {
      pos++;
    }
  }

  function parseNumber(): number {
    skipWhitespace();
    const start = pos;

    // Integer part: zero or more digits (may be empty for leading-decimal forms like ".9")
    const intStart = pos;
    while (pos < cleaned.length && cleaned[pos] >= "0" && cleaned[pos] <= "9") {
      pos++;
    }
    const hasIntPart = pos > intStart;

    // Optional fractional part: '.' followed by at least one digit
    let hasFracPart = false;
    if (pos < cleaned.length && cleaned[pos] === ".") {
      pos++; // consume '.'
      const fracStart = pos;
      while (pos < cleaned.length && cleaned[pos] >= "0" && cleaned[pos] <= "9") {
        pos++;
      }
      if (fracStart === pos) throw new Error("unexpected"); // trailing dot with no digits
      hasFracPart = true;
    }

    // Require at least one of: integer part or fractional part
    if (!hasIntPart && !hasFracPart) throw new Error("unexpected");

    const num = Number(cleaned.slice(start, pos));
    if (!Number.isFinite(num)) throw new Error("unexpected");
    return num;
  }

  function parseFactor(): number {
    if (peek() === "-") {
      consume("-");
      return -parseFactor();
    }
    if (peek() === "(") {
      consume("(");
      const result = parseExpr();
      consume(")");
      return result;
    }
    return parseNumber();
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const right = parseFactor();
      if (op === "*") {
        left = left * right;
      } else {
        if (right === 0) throw new Error("division by zero");
        left = left / right;
      }
    }
    return left;
  }

  function parseExpr(): number {
    let left = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      if (op === "+") {
        left = left + right;
      } else {
        left = left - right;
      }
    }
    return left;
  }

  try {
    const result = parseExpr();
    // Ensure entire input was consumed
    skipWhitespace();
    if (pos !== cleaned.length) return null;
    // Guard against Infinity/NaN
    if (!Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}
