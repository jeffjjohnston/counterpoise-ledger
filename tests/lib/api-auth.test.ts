import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));

import { getSession } from "@/lib/session";
import { getDb } from "@/db";
import { authenticateRequest, authenticateBookRequest, isError } from "@/lib/api-auth";

describe("isError", () => {
  it("returns true when result has error property", () => {
    const result = { error: NextResponse.json({ error: "fail" }, { status: 401 }) };
    expect(isError(result)).toBe(true);
  });

  it("returns false when result has db/bookId (success)", () => {
    const result = { db: {}, bookId: 1, userId: 1, book: {} };
    expect(isError(result as unknown as Awaited<ReturnType<typeof authenticateBookRequest>>)).toBe(false);
  });
});

describe("authenticateRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns userId when session exists", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: 42, sessionId: 1 });

    const result = await authenticateRequest();
    expect(result).toEqual({ userId: 42 });
  });

  it("returns 401 error when no session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const result = await authenticateRequest();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });
});

describe("authenticateBookRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const result = await authenticateBookRequest("1");
    expect(isError(result)).toBe(true);
    if (isError(result)) {
      expect(result.error.status).toBe(401);
    }
  });

  it("returns 400 for non-numeric bookId", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: 1, sessionId: 1 });

    const result = await authenticateBookRequest("abc");
    expect(isError(result)).toBe(true);
    if (isError(result)) {
      expect(result.error.status).toBe(400);
    }
  });

  it("returns 404 when book not found", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: 1, sessionId: 1 });

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    vi.mocked(getDb).mockReturnValue({ select: mockSelect } as unknown as ReturnType<typeof getDb>);

    const result = await authenticateBookRequest("999");
    expect(isError(result)).toBe(true);
    if (isError(result)) {
      expect(result.error.status).toBe(404);
    }
  });

  it("returns success with db, bookId, userId, and book on valid request", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: 1, sessionId: 1 });

    const mockBook = { id: 5, userId: 1, name: "My Book", createdAt: new Date(), updatedAt: new Date() };
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([mockBook]),
      }),
    });
    const mockDb = { select: mockSelect };
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const result = await authenticateBookRequest("5");
    expect(isError(result)).toBe(false);
    if (!isError(result)) {
      expect(result.bookId).toBe(5);
      expect(result.userId).toBe(1);
      expect(result.book).toBe(mockBook);
      expect(result.db).toBe(mockDb);
    }
  });
});
