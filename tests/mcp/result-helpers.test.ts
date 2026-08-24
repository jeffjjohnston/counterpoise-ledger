import { describe, it, expect } from "vitest";
import { ok, fail } from "@/mcp/tools/_result";

describe("ok", () => {
  it("wraps data as a single pretty-printed JSON text block", () => {
    const result = ok({ id: 1, name: "Checking" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 1, name: "Checking" });
    // JSON.parse discards whitespace, so the assertion above cannot tell a
    // pretty-printed body from a compact one. Pin the raw text too, so the
    // 2-space indent is a decision, not an accident.
    expect(result.content[0].text).toContain('\n  "id"');
  });

  it("produces valid JSON for undefined data", () => {
    const result = ok(undefined);
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(JSON.parse(result.content[0].text)).toBeNull();
  });

  it("does not set isError", () => {
    expect(ok({}).isError).toBeUndefined();
  });

  it("preserves an array at the top level", () => {
    const result = ok([1, 2, 3]);
    expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3]);
  });
});

describe("fail", () => {
  it("wraps the message under an error key and sets isError", () => {
    const result = fail("Security not found");
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "Security not found" });
  });
});
