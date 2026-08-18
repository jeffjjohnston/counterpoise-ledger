import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as GETAccounts } from "@/app/api/b/[bookId]/accounts/route";
import { PUT as PUTAccount } from "@/app/api/b/[bookId]/accounts/[id]/route";
import {
  createAccount,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("Account favorites", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("persists account favorite state updates", async () => {
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });

    const updateResponse = await PUTAccount(
      new Request(`http://localhost/api/accounts/${checking.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: true }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(checking.id) }) }
    );

    expect(updateResponse.status).toBe(200);
    const updatePayload = await updateResponse.json();
    expect(updatePayload).toMatchObject({
      id: checking.id,
      isFavorite: true,
    });

    const listResponse = await GETAccounts(
      new Request("http://localhost/api/accounts?includeInactive=true"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    expect(listResponse.status).toBe(200);

    const listPayload = await listResponse.json();
    expect(listPayload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: checking.id,
          isFavorite: true,
        }),
      ])
    );
  });
});
