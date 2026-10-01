import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { insert } from "../helpers/sql";
import { contract } from "../helpers/contract";

type MemberBody = { userId: number; username: string; role: string; createdAt: string; [field: string]: unknown };
const bookMemberListSchema = contract<MemberBody[]>("BookMemberList");
const bookMemberSchema = contract<MemberBody>("BookMember");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

describe("book member HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ: "America/New_York" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  const body = (method: string, value: unknown): RequestInit => ({
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });

  it("adds, lists, changes, and removes a member", async () => {
    const user = await createUser({ username: "member" });
    const before = Date.now();
    const added = await client.request("/api/books/1/members", body("POST", { username: " member ", role: "viewer" }));
    expect(added.status).toBe(200);
    const member = bookMemberSchema.parse(await added.json());
    expect(member).toMatchObject({ userId: user.id, username: "member", role: "viewer" });
    expect(new Date(member.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(member.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const listed = await client.request("/api/books/1/members");
    expect(listed.status).toBe(200);
    expect(bookMemberListSchema.parse(await listed.json()).map((member) => member.role)).toEqual(["owner", "viewer"]);
    const changed = await client.request(`/api/books/1/members/${user.id}`, body("PUT", { role: "editor" }));
    expect(changed.status).toBe(200);
    expect(bookMemberSchema.parse(await changed.json()).role).toBe("editor");
    const removed = await client.request(`/api/books/1/members/${user.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true });
  });

  it("keeps the last owner and exact-username rules", async () => {
    const user = await createUser({ username: "Member" });
    const unknown = await client.request("/api/books/1/members", body("POST", { username: "member", role: "viewer" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "Cannot add that user" });
    const invalid = await client.request("/api/books/1/members", body("POST", { username: "Member", role: "admin" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "role must be owner, editor or viewer" });
    const demote = await client.request("/api/books/1/members/1", body("PUT", { role: "viewer" }));
    expect(demote.status).toBe(400);
    expect(await demote.json()).toEqual({ error: "A book must keep at least one owner" });
    const leave = await client.request("/api/books/1/members/1", { method: "DELETE" });
    expect(leave.status).toBe(400);
    expect(await leave.json()).toEqual({ error: "A book must keep at least one owner" });
    const missing = await client.request(`/api/books/1/members/${user.id}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "That user is not a member of this book" });
  });

  it("accepts Number-compatible path IDs", async () => {
    const user = await createUser({ username: "numeric-member" });
    await client.request("/api/books/1/members", body("POST", { username: "numeric-member", role: "viewer" }));
    const changed = await client.request(`/api/books/1/members/0x${user.id.toString(16)}`, body("PUT", { role: "editor" }));
    expect(changed.status).toBe(200);
    expect(bookMemberSchema.parse(await changed.json()).role).toBe("editor");
    const removed = await client.request(`/api/books/1/members/%20${user.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  /** A real session for another user, as sessionHttpClient makes for user 1. */
  async function sessionFor(userId: number) {
    const token = randomBytes(32).toString("hex");
    await insert("sessions", {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", `counterpoise_session=${token}`);
      return fetch(new URL(path, baseUrl), { ...init, headers });
    };
  }

  async function owners(request: Client["request"]) {
    const listed = await request("/api/books/1/members");
    expect(listed.status).toBe(200);
    return bookMemberListSchema.parse(await listed.json())
      .filter((member) => member.role === "owner")
      .map((member) => member.userId);
  }

  it("serializes concurrent owner demotions so one owner remains", async () => {
    const user = await createUser({ username: "second-owner" });
    const second = await sessionFor(user.id);
    const added = await client.request("/api/books/1/members", body("POST", { username: "second-owner", role: "owner" }));
    expect(added.status).toBe(200);
    // Each owner demotes itself, so each actor is still an owner when its
    // request starts. The server runs the two writes one after the other,
    // so the second write sees one owner and refuses. Several rounds make
    // it likely that the two requests overlap at least once.
    for (let round = 0; round < 5; round += 1) {
      expect(await owners(client.request)).toEqual([1, user.id]);
      const responses = await Promise.all([
        client.request("/api/books/1/members/1", body("PUT", { role: "viewer" })),
        second(`/api/books/1/members/${user.id}`, body("PUT", { role: "viewer" })),
      ]);
      const results = await Promise.all(
        responses.map(async (response) => ({ status: response.status, body: await response.json() }))
      );
      const accepted = results.filter((result) => result.status === 200);
      expect(accepted, JSON.stringify(results)).toHaveLength(1);
      expect(results.filter((result) => result.status !== 200)).toEqual([
        { status: 400, body: { error: "A book must keep at least one owner" } },
      ]);

      // The actor that won is now a viewer. The other one is the only owner,
      // and it makes the winner an owner again for the next round.
      const winner = accepted[0].body.userId as number;
      const [remaining, restore] = winner === 1 ? [user.id, second] : [1, client.request];
      expect(await owners(restore)).toEqual([remaining]);
      const restored = await restore(`/api/books/1/members/${winner}`, body("PUT", { role: "owner" }));
      expect(restored.status).toBe(200);
    }
  });
});
