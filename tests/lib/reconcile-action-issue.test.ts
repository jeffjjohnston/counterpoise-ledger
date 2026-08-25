import { describe, expect, it } from "vitest";
import { reconcileActionIssue, reconcileSchema } from "@/lib/schemas/sync";

describe("reconcileActionIssue", () => {
  it("requires transactionId for match", () => {
    expect(reconcileActionIssue({ action: "match" })).toEqual({
      path: "transactionId",
      message: "transactionId is required for match",
    });
  });

  it("requires transactionId for match_update_amount", () => {
    expect(reconcileActionIssue({ action: "match_update_amount" })).toEqual({
      path: "transactionId",
      message: "transactionId is required for match_update_amount",
    });
  });

  it("requires a positive counterAccountId for create", () => {
    expect(reconcileActionIssue({ action: "create", counterAccountId: 0 })).toEqual({
      path: "counterAccountId",
      message: "counterAccountId is required for create",
    });
  });

  it("accepts a non-positive transactionId for match, as the route always did", () => {
    // The original chain used Number.isInteger only — no .positive() — so a
    // zero or negative transactionId passes the shape check and fails later at
    // the DB lookup. Tightening it here would be a new refusal.
    expect(reconcileActionIssue({ action: "match", transactionId: 0 })).toBeNull();
  });

  it("returns null for the three actions that need no extra field", () => {
    expect(reconcileActionIssue({ action: "ignore" })).toBeNull();
    expect(reconcileActionIssue({ action: "keep_local" })).toBeNull();
    expect(reconcileActionIssue({ action: "unlink" })).toBeNull();
  });

  it("still rejects through the schema itself", () => {
    const result = reconcileSchema.safeParse({ action: "match", reconciliationId: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe("transactionId is required for match");
    expect(result.error?.issues[0].path).toEqual(["transactionId"]);
  });
});
