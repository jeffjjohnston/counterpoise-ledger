import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { toolShape } from "@/mcp/tools/_tool-shape";
import { updateIssueReportSchema } from "@/lib/schemas/issue-reports";

describe("toolShape", () => {
  it("returns the shape of a plain object schema", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    expect(Object.keys(toolShape(schema))).toEqual(["a", "b"]);
  });

  it("throws for a schema carrying an object-level .refine()", () => {
    const schema = z.object({ a: z.string().optional() }).refine((v) => v.a !== undefined);
    expect(() => toolShape(schema)).toThrow(/object-level/);
  });

  it("throws for a schema carrying an object-level .superRefine()", () => {
    const schema = z.object({ a: z.string().optional() }).superRefine(() => {});
    expect(() => toolShape(schema)).toThrow(/object-level/);
  });

  it("allows a refined schema when the caller names where the rule is enforced", () => {
    const schema = z.object({ a: z.string().optional() }).refine((v) => v.a !== undefined);
    expect(
      Object.keys(toolShape(schema, { objectRefineHandledBy: "lib/x.ts:doX" }))
    ).toEqual(["a"]);
  });

  // Regression anchor for the one real schema in the codebase that carries a
  // refinement. If someone deletes updateIssueReportSchema's .refine(), this
  // test fails and points at lib/issue-reports.ts's now-orphaned guard.
  it("guards updateIssueReportSchema, the only spread schema with a refinement", () => {
    expect(() => toolShape(updateIssueReportSchema)).toThrow(/object-level/);
  });

  // zod v4 leaves _zod.def.checks UNDEFINED on a plain object rather than
  // setting it to []. Measured, not assumed: a bare `checks.length` read
  // throws TypeError on every clean schema.
  it("treats a plain object's absent `checks` as zero rather than crashing", () => {
    const schema = z.object({ a: z.string() });
    expect(
      (schema as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks
    ).toBeUndefined();
    expect(() => toolShape(schema)).not.toThrow();
  });
});
