import { describe, it, expect } from "vitest";
import {
  createIssueReportSchema,
  updateIssueReportSchema,
} from "@/lib/schemas/issue-reports";

describe("createIssueReportSchema", () => {
  it("accepts a full valid report", () => {
    const r = createIssueReportSchema.safeParse({
      description: "The balance is wrong",
      type: "bug",
      page: "/b/1/transactions",
    });
    expect(r.success).toBe(true);
  });

  it("defaults type to bug when omitted", () => {
    const r = createIssueReportSchema.safeParse({
      description: "Something is off",
      page: "/b/1",
    });
    expect(r.success).toBe(true);
    expect(r.data!.type).toBe("bug");
  });

  it("defaults type to bug when explicitly undefined", () => {
    const r = createIssueReportSchema.safeParse({
      description: "Something is off",
      page: "/b/1",
      type: undefined,
    });
    expect(r.success).toBe(true);
    expect(r.data!.type).toBe("bug");
  });

  it("does not default an explicit null type", () => {
    const r = createIssueReportSchema.safeParse({
      description: "Something is off",
      page: "/b/1",
      type: null,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Invalid type. Must be one of: bug, improvement, other"
    );
  });

  it("trims the stored description", () => {
    const r = createIssueReportSchema.safeParse({
      description: "  Something is off  ",
      page: "/b/1",
    });
    expect(r.success).toBe(true);
    expect(r.data!.description).toBe("Something is off");
  });

  it("rejects a missing description with the ported message", () => {
    const r = createIssueReportSchema.safeParse({ page: "/b/1" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description is required");
  });

  it("rejects a whitespace-only description", () => {
    const r = createIssueReportSchema.safeParse({ description: "   ", page: "/b/1" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description is required");
  });

  it("rejects a missing page with the ported message", () => {
    const r = createIssueReportSchema.safeParse({ description: "test" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Page is required");
  });

  it("accepts a whitespace-only page (no trimming/emptiness check, matching the original guard)", () => {
    const r = createIssueReportSchema.safeParse({ description: "test", page: "   " });
    expect(r.success).toBe(true);
    expect(r.data!.page).toBe("   ");
  });

  it("rejects an invalid type with the ported message", () => {
    const r = createIssueReportSchema.safeParse({
      description: "test",
      page: "/b/1",
      type: "urgent",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Invalid type. Must be one of: bug, improvement, other"
    );
  });

  it("reports description before page when both are missing", () => {
    const r = createIssueReportSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description is required");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = createIssueReportSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description is required");
  });
});

describe("updateIssueReportSchema", () => {
  it("accepts a description-only update", () => {
    const r = updateIssueReportSchema.safeParse({ description: "Updated" });
    expect(r.success).toBe(true);
  });

  it("accepts a status-only update", () => {
    const r = updateIssueReportSchema.safeParse({ status: "resolved" });
    expect(r.success).toBe(true);
  });

  it("accepts a type-only update", () => {
    const r = updateIssueReportSchema.safeParse({ type: "improvement" });
    expect(r.success).toBe(true);
  });

  it("trims the stored description", () => {
    const r = updateIssueReportSchema.safeParse({ description: "  Updated  " });
    expect(r.success).toBe(true);
    expect(r.data!.description).toBe("Updated");
  });

  it("rejects an empty body with the 'no valid fields' message", () => {
    const r = updateIssueReportSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("No valid fields to update");
  });

  it("rejects an empty-string description with the field-specific message, not 'no valid fields'", () => {
    const r = updateIssueReportSchema.safeParse({ description: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description cannot be empty");
  });

  it("rejects a whitespace-only description", () => {
    const r = updateIssueReportSchema.safeParse({ description: "   " });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Description cannot be empty");
  });

  it("rejects an invalid status with the ported message", () => {
    const r = updateIssueReportSchema.safeParse({ status: "urgent" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Invalid status. Must be one of: new, resolved, wontfix"
    );
  });

  it("rejects an invalid type with the ported message", () => {
    const r = updateIssueReportSchema.safeParse({ type: "urgent" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Invalid type. Must be one of: bug, improvement, other"
    );
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported 'no valid fields' message", (_label, input) => {
    const r = updateIssueReportSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("No valid fields to update");
  });
});
