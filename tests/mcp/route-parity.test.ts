import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "@/mcp/register-all";
import { ROUTE_TOOLS, ROUTE_WAIVERS, TOOLS_WITHOUT_ROUTES } from "./route-coverage";

const API_ROOT = resolve(__dirname, "../../app/api");
// `async` is optional here on purpose. Next.js does not require a route
// handler to be async, so a non-async handler with a required `async` in
// this pattern would not match — discoverRouteMethods() would silently drop
// it, and the parity guard would never flag the missing MCP tool.
const METHOD_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
// Next.js accepts route.js, route.jsx, and route.tsx alongside route.ts. All
// 56 current route files are .ts, so this widening changes no discovered
// route today — it is free insurance against a future .tsx route silently
// going unguarded.
const ROUTE_FILE_RE = /^route\.[jt]sx?$/;

/** Every "<METHOD> <path>" key the app actually serves. */
function discoverRouteMethods(): string[] {
  const keys: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (ROUTE_FILE_RE.test(entry.name)) {
        const source = readFileSync(full, "utf8");
        const suffixLength = 1 + entry.name.length; // "/" + the filename
        const routePath =
          "/" + full.slice(API_ROOT.length + 1, -suffixLength).split(/[\\/]/).join("/");
        for (const match of source.matchAll(METHOD_RE)) {
          keys.push(`${match[1]} ${routePath}`);
        }
      }
    }
  }

  walk(API_ROOT);
  return keys.sort();
}

let registeredToolNames: string[];

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerAllTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  registeredToolNames = (await client.listTools()).tools.map((t) => t.name);
});

describe("MCP route parity", () => {
  it("accounts for every route method", () => {
    const unaccounted = discoverRouteMethods().filter(
      (key) => !(key in ROUTE_TOOLS) && !(key in ROUTE_WAIVERS)
    );
    expect(
      unaccounted,
      "Add an MCP tool for each route below, or add a ROUTE_WAIVERS entry saying why not."
    ).toEqual([]);
  });

  it("has no stale coverage entries", () => {
    const live = new Set(discoverRouteMethods());
    const stale = [...Object.keys(ROUTE_TOOLS), ...Object.keys(ROUTE_WAIVERS)].filter(
      (key) => !live.has(key)
    );
    expect(stale, "These routes no longer exist. Remove them from route-coverage.ts.").toEqual([]);
  });

  it("names only tools that are actually registered", () => {
    const named = new Set(Object.values(ROUTE_TOOLS).flat());
    const missing = [...named].filter((name) => !registeredToolNames.includes(name));
    expect(missing, "route-coverage.ts names a tool the server does not register.").toEqual([]);
  });

  it("maps every registered tool to a route or declares it routeless", () => {
    const mapped = new Set([...Object.values(ROUTE_TOOLS).flat(), ...TOOLS_WITHOUT_ROUTES]);
    const orphans = registeredToolNames.filter((name) => !mapped.has(name));
    expect(orphans, "Add these to ROUTE_TOOLS or TOOLS_WITHOUT_ROUTES.").toEqual([]);
  });

  it("gives every waiver a reason", () => {
    const empty = Object.entries(ROUTE_WAIVERS)
      .filter(([, reason]) => !reason.trim())
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  // While the tools were being added a route at a time, the realistic mistake
  // was adding the ROUTE_TOOLS entry for a route and forgetting to delete its
  // pending-plan-N waiver: the route then looked both covered and waived, and
  // the pending checklist under-reported silently. That waiver mechanism is
  // gone (see route-coverage.ts), but the same mistake is possible with any
  // waiver — this guard is what catches a route left mapped and waived at once.
  it("maps and waives disjoint sets of routes", () => {
    const both = Object.keys(ROUTE_TOOLS).filter((key) => key in ROUTE_WAIVERS);
    expect(
      both,
      "These routes are in both ROUTE_TOOLS and ROUTE_WAIVERS. Delete the stale waiver."
    ).toEqual([]);
  });

  // Guards against a stale TOOLS_WITHOUT_ROUTES entry — a name left behind
  // after its tool was renamed or removed. Nothing else here checks these
  // names against the live registry, so a stale one just sits in the list
  // doing nothing: it exempts no real orphan, and no test fails.
  it("names only tools that are actually registered in TOOLS_WITHOUT_ROUTES", () => {
    const missing = TOOLS_WITHOUT_ROUTES.filter(
      (name) => !registeredToolNames.includes(name)
    );
    expect(
      missing,
      "TOOLS_WITHOUT_ROUTES names a tool the server does not register."
    ).toEqual([]);
  });
});
