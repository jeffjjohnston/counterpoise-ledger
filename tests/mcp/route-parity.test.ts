import { describe, it, expect } from "vitest";
import manifest from "@/rust-api/server/mcp-tools.json";
import routes from "@/rust-api/routes.json";
import { ROUTE_TOOLS, ROUTE_WAIVERS, TOOLS_WITHOUT_ROUTES } from "./route-coverage";

/**
 * Every "<METHOD> <path>" key the API serves, with the /api prefix removed:
 * the routes in rust-api/routes.json, and the health probe that the Rust
 * router registers by name. MCP over HTTP and WebMCP are the MCP transports
 * themselves, not routes a tool could cover.
 */
function discoverRouteMethods(): string[] {
  const keys = routes.map((route) => `${route.method} ${route.path.replace(/^\/api/, "")}`);
  return [...keys, "GET /health"].sort();
}

/** Every tool the MCP server serves: the manifest's names. */
const registeredToolNames = manifest.map((tool) => tool.name);

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
