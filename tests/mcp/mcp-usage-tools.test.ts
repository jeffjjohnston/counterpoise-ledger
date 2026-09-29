import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { createUser, resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";

// A fake PostHog Query API. It records each HogQL query and answers with the
// next reply of its kind: a count query (GROUP BY) or a recent-events query.
// The Rust server gets its URL and key in its environment when it starts.
type Reply = { status: number; body: unknown };
const queries: string[] = [];
let countReply: Reply;
let recentReply: Reply;
let authorization: string | undefined;
let posthog: Server;

let mcp: McpTestClient;
let callerId: number;

const API_KEY = "phx_test_personal_key";

beforeAll(async () => {
  await setupTestDatabase();
  posthog = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      authorization = request.headers.authorization;
      const query: string = JSON.parse(body).query.query;
      queries.push(query);
      const reply = query.includes("GROUP BY") ? countReply : recentReply;
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => posthog.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
  mcp = await connectMcpTestClient({
    env: { NEXT_PUBLIC_POSTHOG_HOST: host, POSTHOG_PERSONAL_API_KEY: API_KEY },
  });
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase();
  // A user other than the seeded user 1, so a filter on a constant ID fails.
  callerId = (await createUser({ username: "usage-caller" })).id;
  queries.length = 0;
  authorization = undefined;
  countReply = { status: 200, body: { columns: [], results: [] } };
  recentReply = { status: 200, body: { columns: [], results: [] } };
});

afterAll(async () => {
  await mcp.close();
  await new Promise<void>((resolve) => posthog.close(() => resolve()));
});

describe("analyze_usage", () => {
  it("limits both queries to the caller's own events", async () => {
    const { isError } = await mcp.callAs(callerId, "analyze_usage", { days: 7 });

    expect(isError).toBe(false);
    expect(authorization).toBe(`Bearer ${API_KEY}`);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain(`distinct_id = '${callerId}'`);
      expect(query).toContain("timestamp > now() - INTERVAL 7 DAY");
    }
  });

  it("keeps the caller filter when an event type is given, and escapes it", async () => {
    await mcp.callAs(callerId, "analyze_usage", { days: 7, eventType: "it's\\here" });

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain(`distinct_id = '${callerId}'`);
      expect(query).toContain("event = 'it\\'s\\\\here'");
    }
  });

  it("floors days, keeps it in 1..90, and defaults to 7", async () => {
    await mcp.callAs(callerId, "analyze_usage", { days: 2.9 });
    await mcp.callAs(callerId, "analyze_usage", {});

    expect(queries.filter((q) => q.includes("INTERVAL 2 DAY"))).toHaveLength(2);
    expect(queries.filter((q) => q.includes("INTERVAL 7 DAY"))).toHaveLength(2);
  });

  it("counts only the rows PostHog returns, and parses the properties", async () => {
    countReply = {
      status: 200,
      body: { columns: ["event", "count()"], results: [["$pageview", 3], ["account_created", 2]] },
    };
    recentReply = {
      status: 200,
      body: {
        columns: ["event", "timestamp", "properties"],
        results: [["$pageview", "2026-09-27T10:00:00Z", '{"$pathname":"/b/1"}']],
      },
    };

    const { data } = await mcp.callAs(callerId, "analyze_usage", { days: 7 });

    expect(data.totalEvents).toBe(5);
    expect(data.period).toMatch(/^last 7 days \(since \d{4}-\d{2}-\d{2}\)$/);
    expect(data.eventCounts).toEqual([
      { event: "$pageview", count: 3 },
      { event: "account_created", count: 2 },
    ]);
    expect(data.recentEvents).toEqual([
      { event: "$pageview", timestamp: "2026-09-27T10:00:00Z", properties: { $pathname: "/b/1" } },
    ]);
  });

  it("reports a PostHog error status with the start of the body", async () => {
    countReply = { status: 500, body: "backend down" };

    // An error thrown past fail() is plain text, so this reads the raw result.
    const { isError, text } = await mcp.callToolAs(callerId, "analyze_usage", { days: 7 });

    expect(isError).toBe(true);
    expect(text).toBe("PostHog API error: 500 Internal Server Error backend down");
  });
});
