import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { deleteTransactionRequest, isTransactionConflict, putTransaction } from "@/lib/transaction-requests";

afterEach(() => vi.unstubAllGlobals());

describe("transaction requests", () => {
  it("sends expectedUpdatedAt in the PUT body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await putTransaction("1", { id: 7, updatedAt: "2026-01-01T00:00:00.000Z" }, { description: "x" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/b/1/transactions/7");
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      description: "x", expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("accepts a Date for updatedAt", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await putTransaction("1", { id: 7, updatedAt: new Date("2026-01-01T00:00:00.000Z") }, {});
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).expectedUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("sends expectedUpdatedAt in the DELETE query", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await deleteTransactionRequest("1", { id: 7, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/b/1/transactions/7?expectedUpdatedAt=2026-01-01T00%3A00%3A00.000Z");
  });

  it("recognises a 409 as a conflict", () => {
    expect(isTransactionConflict(new ApiError("x", 409))).toBe(true);
    expect(isTransactionConflict(new ApiError("x", 400))).toBe(false);
    expect(isTransactionConflict(new Error("x"))).toBe(false);
  });
});
