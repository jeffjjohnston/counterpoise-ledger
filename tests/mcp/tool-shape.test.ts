import fs from "node:fs";
import path from "node:path";
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

  // Regression anchor on one real refined schema. It is not the only one —
  // reconcileSchema in lib/schemas/sync.ts carries a superRefine and also goes
  // through toolShape() — but it is the one this test pins: if someone deletes
  // updateIssueReportSchema's .refine(), this fails and points at
  // lib/issue-reports.ts's now-orphaned guard.
  it("guards updateIssueReportSchema, a spread schema carrying a refinement", () => {
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

describe("toolShape and derived schemas", () => {
  const refined = z
    .object({ a: z.string().optional(), b: z.string().optional() })
    .refine((v) => v.a !== undefined || v.b !== undefined, { error: "need one" });

  // Zod 4.5 now rejects omit/pick/partial on refined objects and preserves
  // refinements through extend. Keep the toolShape guard: spreading .shape
  // still loses the object-level rule.
  it("zod refuses derivations that would drop an object-level refinement", () => {
    for (const derive of [
      () => refined.omit({ b: true }),
      () => refined.pick({ a: true }),
      () => refined.partial(),
    ]) {
      expect(derive).toThrow(/refinements/);
    }
    const extended = refined.extend({ c: z.string().optional() });
    expect(extended.safeParse({}).success).toBe(false);
    expect(() => toolShape(extended)).toThrow(/object-level/);
    expect(refined.safeParse({}).success).toBe(false);
  });

  it("checks the base schema before omitting, so a derivation cannot launder a refinement away", () => {
    expect(() => toolShape(refined, { omit: { b: true } })).toThrow(/object-level/);
  });

  it("omits the named keys from the returned shape", () => {
    const plain = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    expect(Object.keys(toolShape(plain, { omit: { b: true } }))).toEqual(["a", "c"]);
  });

  it("still returns every key when no omit is given", () => {
    const plain = z.object({ a: z.string(), b: z.number() });
    expect(Object.keys(toolShape(plain))).toEqual(["a", "b"]);
  });
});

// Always hand toolShape the original schema. Older Zod versions silently
// dropped refinements during derivation; Zod 4.5 rejects unsafe derivations.
// The omit option keeps this invariant independent of Zod's derivation behavior.
describe("toolShape call sites", () => {
  it("never derives a schema inline before handing it to toolShape", () => {
    const toolsDir = path.join(process.cwd(), "mcp", "tools");
    const offenders: string[] = [];

    for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      if (file === "_tool-shape.ts") continue;
      const source = fs.readFileSync(path.join(toolsDir, file), "utf8");
      // toolShape(  <identifier>  .omit( / .pick( / .extend( / .partial(
      const derived = /toolShape\(\s*[A-Za-z0-9_$]+\s*\.\s*(omit|pick|extend|partial)\s*\(/g;
      for (const match of source.matchAll(derived)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`mcp/tools/${file}:${line} — ${match[0].trim()}`);
      }
    }

    expect(
      offenders,
      "Derive inside toolShape instead: toolShape(baseSchema, { omit: { field: true } })"
    ).toEqual([]);
  });
});
