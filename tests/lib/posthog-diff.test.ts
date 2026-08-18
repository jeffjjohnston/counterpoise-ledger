import { describe, expect, it } from "vitest";
import { diffTransactionFields } from "@/lib/posthog-server";

describe("diffTransactionFields", () => {
  const baseTx = {
    date: "2025-03-01",
    description: "Weekly shop",
    notes: null as string | null,
    checkNumber: null as string | null,
    isReconciled: false,
    payee: { name: "Whole Foods" } as { name: string } | null,
    splits: [
      { accountId: 10, amount: -4500 },
      { accountId: 20, amount: 4500 },
    ],
  };

  it("returns empty array when nothing changed", () => {
    const body = {
      date: "2025-03-01",
      description: "Weekly shop",
      payeeName: "Whole Foods",
      splits: [
        { accountId: 10, amount: -4500 },
        { accountId: 20, amount: 4500 },
      ],
    };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toEqual([]);
    expect(result.splitsAccountsChanged).toBe(false);
  });

  it("detects date change", () => {
    const body = { date: "2025-03-02", description: "Weekly shop", payeeName: "Whole Foods", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("date");
  });

  it("detects description change", () => {
    const body = { date: "2025-03-01", description: "Monthly shop", payeeName: "Whole Foods", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("description");
  });

  it("detects payee change", () => {
    const body = { date: "2025-03-01", description: "Weekly shop", payeeName: "Trader Joe's", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("payeeName");
  });

  it("detects payee added where none existed", () => {
    const txNoPayee = { ...baseTx, payee: null };
    const body = { date: "2025-03-01", description: "Weekly shop", payeeName: "Whole Foods", splits: baseTx.splits };
    const result = diffTransactionFields(txNoPayee, body);
    expect(result.fieldsChanged).toContain("payeeName");
  });

  it("detects payee removed", () => {
    const body = { date: "2025-03-01", description: "Weekly shop", payeeName: "", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("payeeName");
  });

  it("detects notes change", () => {
    const body = { date: "2025-03-01", description: "Weekly shop", payeeName: "Whole Foods", notes: "new note", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("notes");
  });

  it("detects isReconciled change", () => {
    const body = { isReconciled: true };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toEqual(["isReconciled"]);
  });

  it("detects split amount change without account change", () => {
    const body = {
      date: "2025-03-01",
      description: "Weekly shop",
      payeeName: "Whole Foods",
      splits: [
        { accountId: 10, amount: -5000 },
        { accountId: 20, amount: 5000 },
      ],
    };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("splits");
    expect(result.splitsAccountsChanged).toBe(false);
  });

  it("detects split account change (recategorization)", () => {
    const body = {
      date: "2025-03-01",
      description: "Weekly shop",
      payeeName: "Whole Foods",
      splits: [
        { accountId: 10, amount: -4500 },
        { accountId: 30, amount: 4500 },
      ],
    };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("splits");
    expect(result.splitsAccountsChanged).toBe(true);
  });

  it("detects checkNumber change", () => {
    const body = { date: "2025-03-01", description: "Weekly shop", payeeName: "Whole Foods", checkNumber: "1234", splits: baseTx.splits };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("checkNumber");
  });

  it("does not report splits changed when splits not in body", () => {
    const body = { isReconciled: true };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).not.toContain("splits");
    expect(result.splitsAccountsChanged).toBe(false);
  });

  it("handles multiple fields changed at once", () => {
    const body = {
      date: "2025-04-01",
      description: "Changed",
      payeeName: "New Payee",
      splits: [
        { accountId: 99, amount: -1000 },
        { accountId: 88, amount: 1000 },
      ],
    };
    const result = diffTransactionFields(baseTx, body);
    expect(result.fieldsChanged).toContain("date");
    expect(result.fieldsChanged).toContain("description");
    expect(result.fieldsChanged).toContain("payeeName");
    expect(result.fieldsChanged).toContain("splits");
    expect(result.splitsAccountsChanged).toBe(true);
  });
});
