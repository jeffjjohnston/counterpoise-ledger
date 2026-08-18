import { describe, it, expect } from "vitest";
import { evaluateExpression } from "@/lib/expression";

describe("evaluateExpression", () => {
  describe("plain numbers (passthrough)", () => {
    it("parses a simple integer", () => {
      expect(evaluateExpression("42")).toBe(42);
    });

    it("parses a decimal", () => {
      expect(evaluateExpression("3.14")).toBeCloseTo(3.14);
    });

    it("parses a negative number", () => {
      expect(evaluateExpression("-5")).toBe(-5);
    });

    it("ignores leading/trailing whitespace", () => {
      expect(evaluateExpression("  100  ")).toBe(100);
    });
  });

  describe("basic operations", () => {
    it("adds two numbers", () => {
      expect(evaluateExpression("100+50")).toBe(150);
    });

    it("subtracts", () => {
      expect(evaluateExpression("200-75")).toBe(125);
    });

    it("multiplies", () => {
      expect(evaluateExpression("12*5")).toBe(60);
    });

    it("divides", () => {
      expect(evaluateExpression("100/4")).toBe(25);
    });

    it("handles spaces around operators", () => {
      expect(evaluateExpression("100 + 50")).toBe(150);
    });

    it("handles tabs and mixed whitespace around operators", () => {
      expect(evaluateExpression("100\t+\t50")).toBe(150);
    });
  });

  describe("operator precedence", () => {
    it("multiplies before adding", () => {
      expect(evaluateExpression("2+3*4")).toBe(14);
    });

    it("divides before subtracting", () => {
      expect(evaluateExpression("10-6/3")).toBe(8);
    });

    it("chains mixed operations", () => {
      expect(evaluateExpression("1+2*3-4/2")).toBe(5);
    });
  });

  describe("parentheses", () => {
    it("overrides precedence", () => {
      expect(evaluateExpression("(2+3)*4")).toBe(20);
    });

    it("handles nested parentheses", () => {
      expect(evaluateExpression("((2+3))*4")).toBe(20);
    });

    it("complex nesting", () => {
      expect(evaluateExpression("(10-(3+2))*2")).toBe(10);
    });
  });

  describe("decimal results", () => {
    it("returns decimal from division", () => {
      expect(evaluateExpression("10/3")).toBeCloseTo(3.333333);
    });

    it("handles decimal operands", () => {
      expect(evaluateExpression("1.50+2.75")).toBeCloseTo(4.25);
    });
  });

  describe("edge cases and invalid input", () => {
    it("returns null for empty string", () => {
      expect(evaluateExpression("")).toBeNull();
    });

    it("returns null for whitespace only", () => {
      expect(evaluateExpression("   ")).toBeNull();
    });

    it("returns null for pure text", () => {
      expect(evaluateExpression("abc")).toBeNull();
    });

    it("returns null for unmatched parens", () => {
      expect(evaluateExpression("(2+3")).toBeNull();
    });

    it("returns null for trailing operator", () => {
      expect(evaluateExpression("5+")).toBeNull();
    });

    it("returns null for double operators", () => {
      expect(evaluateExpression("5++3")).toBeNull();
    });

    it("returns null for division by zero", () => {
      expect(evaluateExpression("10/0")).toBeNull();
    });

    it("returns plain number for currency-formatted input", () => {
      expect(evaluateExpression("$1,234.56")).toBeCloseTo(1234.56);
    });

    it("handles negative result", () => {
      expect(evaluateExpression("5-10")).toBe(-5);
    });

    it("returns null for scientific notation (not supported)", () => {
      expect(evaluateExpression("1e999+1e999")).toBeNull();
    });

    it("returns null for multiple decimal points", () => {
      expect(evaluateExpression("1..2")).toBeNull();
    });

    it("returns null for trailing decimal point", () => {
      expect(evaluateExpression("5.")).toBeNull();
    });

    it("returns null for lone decimal point", () => {
      expect(evaluateExpression(".")).toBeNull();
    });
  });

  describe("leading-decimal numbers", () => {
    it("parses a number with no integer part", () => {
      expect(evaluateExpression(".5")).toBeCloseTo(0.5);
    });

    it("multiplies by a leading-decimal number", () => {
      expect(evaluateExpression("5*.9")).toBeCloseTo(4.5);
    });

    it("adds two leading-decimal numbers", () => {
      expect(evaluateExpression(".25+.75")).toBeCloseTo(1);
    });

    it("negates a leading-decimal number", () => {
      expect(evaluateExpression("-.5")).toBeCloseTo(-0.5);
    });

    it("handles leading-decimal numbers in parentheses", () => {
      expect(evaluateExpression("(.5+.5)*2")).toBeCloseTo(2);
    });
  });

  describe("real-world amount expressions", () => {
    it("splitting a dinner bill", () => {
      expect(evaluateExpression("85.40/2")).toBeCloseTo(42.70);
    });

    it("rent plus utilities", () => {
      expect(evaluateExpression("1200+150+75")).toBe(1425);
    });

    it("discount calculation", () => {
      expect(evaluateExpression("250*0.8")).toBeCloseTo(200);
    });

    it("tax calculation", () => {
      expect(evaluateExpression("100*(1+0.0625)")).toBeCloseTo(106.25);
    });
  });
});
