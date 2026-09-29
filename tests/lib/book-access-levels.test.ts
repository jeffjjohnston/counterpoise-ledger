import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/rust-api/server/mcp-tools.json";
import routes from "@/rust-api/routes.json";

const ROUTES_DIR = "rust-api/server/src/routes";

/**
 * The handler function of each route, from the match arms in `routes/mod.rs`.
 * An arm has the form
 * `("GET", "/api/b/[bookId]/things", "things.list") => router.route("...", get(list_things))`.
 */
function routeHandlers(source: string): Map<string, string> {
  const arm =
    /\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)",\s*"[\w.]+",?\s*\)\s*=>\s*(?:\{\s*)?router\s*\.\s*route\(\s*[^,]+,\s*(?:axum::routing::)?(?:get|post|put|patch|delete)\((\w+)\)/g;
  return new Map([...source.matchAll(arm)].map(([, method, path, handler]) => [`${method} ${path}`, handler]));
}

/**
 * The levels that a handler gives to `authenticate_book`, as the
 * `AccessLevel::` names in its body. The body continues until the next
 * function starts, so a level in a private helper is not seen.
 */
function handlerLevels(sources: string[], handler: string): string[] | undefined {
  for (const source of sources) {
    const start = source.search(new RegExp(`pub\\(crate\\) async fn ${handler}\\b`));
    if (start === -1) continue;
    const rest = source.slice(start + 1);
    const next = rest.search(/\n\s*(?:pub\((?:crate|super)\) )?(?:async )?fn \w+/);
    const body = next === -1 ? rest : rest.slice(0, next);
    return [...body.matchAll(/AccessLevel::(\w+)/g)].map((m) => m[1].toLowerCase());
  }
  return undefined;
}

/** Operations that only an owner can do. */
const OWNER_ROUTES = new Set([
  "POST /api/b/[bookId]/sync/tokens",
  "PUT /api/b/[bookId]/sync/tokens/[id]",
  "DELETE /api/b/[bookId]/sync/tokens/[id]",
  "PUT /api/b/[bookId]/sync/tokens/[id]/accounts",
]);

/**
 * Handlers that authenticate in a shared helper, not in their own body. Each
 * entry gives the exact call that the handler's file must contain.
 */
const HELPER_ROUTES: Record<string, { file: string; call: string }> = {
  // POST, PATCH and PUT all use quota or write evaluation rows.
  request_route: { file: "typesafe_suggestion.rs", call: "authenticate_book(state, headers, raw_book_id, AccessLevel::Write, UNAVAILABLE)" },
  display_route: { file: "typesafe_suggestion.rs", call: "authenticate_book(state, headers, raw_book_id, AccessLevel::Write, UNAVAILABLE)" },
  confirm_route: { file: "typesafe_suggestion.rs", call: "authenticate_book(state, headers, raw_book_id, AccessLevel::Write, UNAVAILABLE)" },
};

/** The problems of one book route. An empty list means that it is correct. */
function routeProblems(key: string, levels: string[] | undefined): string[] {
  if (levels === undefined) return [`${key}: no handler function found in ${ROUTES_DIR}`];
  const method = key.split(" ")[0];
  const expected = method === "GET" ? "read" : OWNER_ROUTES.has(key) ? "owner" : "write";
  return levels.length === 1 && levels[0] === expected
    ? []
    : [`${key}: expected one authenticate_book at "${expected}", found [${levels.join(", ")}]`];
}

describe("Rust book routes declare their access level", () => {
  const sources = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".rs"))
    .map((f) => readFileSync(join(ROUTES_DIR, f), "utf8"));
  const handlers = routeHandlers(readFileSync(join(ROUTES_DIR, "mod.rs"), "utf8"));
  const bookRoutes = routes
    .filter((route) => route.path.startsWith("/api/b/[bookId]/"))
    .map((route) => `${route.method} ${route.path}`);

  it("finds a handler for every book route in the manifest", () => {
    expect(bookRoutes.length).toBeGreaterThan(40);
    expect(bookRoutes.filter((key) => !handlers.has(key))).toEqual([]);
  });

  it.each(Object.entries(HELPER_ROUTES))("%s authenticates in %o", (_handler, { file, call }) => {
    expect(readFileSync(join(ROUTES_DIR, file), "utf8")).toContain(call);
  });

  it("pairs every handler with the right level", () => {
    const problems = bookRoutes
      .filter((key) => !(handlers.get(key)! in HELPER_ROUTES))
      .flatMap((key) => routeProblems(key, handlerLevels(sources, handlers.get(key)!)));
    expect(problems).toEqual([]);
  });
});

describe("route scan", () => {
  it("reads the handler of a one-line and a wrapped arm", () => {
    const source = `
      ("GET", "/api/b/[bookId]/things", "things.list") => {
          router.route("/api/b/{book_id}/things", get(list_things))
      }
      ("PUT", "/api/b/[bookId]/things/[id]", "things.update") => router
          .route(
              "/api/b/{book_id}/things/{id}",
              axum::routing::put(update_thing),
          ),`;
    expect(routeHandlers(source)).toEqual(
      new Map([
        ["GET /api/b/[bookId]/things", "list_things"],
        ["PUT /api/b/[bookId]/things/[id]", "update_thing"],
      ])
    );
  });

  it("reads the levels in a handler's own body only", () => {
    const source = `
      pub(crate) async fn list_things(headers: HeaderMap) -> ApiResult {
          authenticate_book(&state, &headers, &raw, AccessLevel::Read, FAILURE).await?;
      }
      async fn helper() { authenticate_book(&state, &headers, &raw, AccessLevel::Write, FAILURE).await?; }
      pub(crate) async fn update_thing(headers: HeaderMap) -> ApiResult {
          helper().await
      }`;
    expect(handlerLevels([source], "list_things")).toEqual(["read"]);
    expect(handlerLevels([source], "update_thing")).toEqual([]);
    expect(handlerLevels([source], "missing")).toBeUndefined();
  });

  it("reports a GET at write, a missing gate, and a missing handler", () => {
    expect(routeProblems("GET /api/b/[bookId]/things", ["write"])).toEqual([
      'GET /api/b/[bookId]/things: expected one authenticate_book at "read", found [write]',
    ]);
    expect(routeProblems("POST /api/b/[bookId]/sync/tokens", [])).toEqual([
      'POST /api/b/[bookId]/sync/tokens: expected one authenticate_book at "owner", found []',
    ]);
    expect(routeProblems("DELETE /api/b/[bookId]/things/[id]", undefined)).toEqual([
      `DELETE /api/b/[bookId]/things/[id]: no handler function found in ${ROUTES_DIR}`,
    ]);
  });
});

/** Tools that only an owner can call. */
const OWNER_TOOLS = new Set([
  "update_plaid_token",
  "delete_plaid_token",
  "set_plaid_token_accounts",
  "add_book_member",
  "update_book_member",
]);

/** Tools that intentionally use a gate level that is different from their annotation. */
const LEVEL_EXCEPTIONS: Record<string, string> = {
  // Any member can remove their own membership. For all other members, the handler checks for owner.
  remove_book_member: "read",
};

/**
 * Tools that do not call `caller.book`. Each of these tools does one of two
 * things. It operates above one book (books, issue reports, usage, system
 * status), or the route it calls checks the membership.
 * If a new tool does not call the gate, the test fails. The test continues to
 * fail until you intentionally add the tool to this list.
 */
const NO_BOOK_GATE = new Set([
  "list_books", "create_book", "update_book", "delete_book", "create_demo_book",
  "create_issue_report", "list_issue_reports", "update_issue_report", "delete_issue_report",
  "get_system_status", "analyze_usage",
]);

/** A tool, whether its annotations mark it read-only, and the levels its handler gives. */
type ToolLevel = { tool: string; readOnly: boolean; levels: string[] };

/** The problems in a set of parsed tools. An empty list means that each tool is correct. */
function toolProblems(tools: ToolLevel[]): string[] {
  const problems: string[] = [];
  for (const { tool, readOnly, levels } of tools) {
    if (levels.length === 0) {
      if (!NO_BOOK_GATE.has(tool)) problems.push(`${tool}: no caller.book call`);
      continue;
    }
    const expected = LEVEL_EXCEPTIONS[tool] ?? (OWNER_TOOLS.has(tool) ? "owner" : readOnly ? "read" : "write");
    if (levels.some((level) => level !== expected)) {
      const kind = readOnly ? "read-only" : "write";
      problems.push(`${tool} (${kind}): expected "${expected}", found [${levels.join(", ")}]`);
    }
  }
  return problems;
}

const RUST_TOOLS_DIR = "rust-api/server/src/mcp/tools";

/**
 * The Rust handler of each tool, from the dispatch in `tools/mod.rs`. Each arm
 * has the form `"list_things" => things::list(caller, arguments).await`.
 */
function rustDispatch(source: string): Array<{ tool: string; module: string; handler: string }> {
  return [...source.matchAll(/"(\w+)"\s*=>\s*(\w+)::(\w+)\(/g)].map(([, tool, module, handler]) => ({
    tool,
    module,
    handler,
  }));
}

/**
 * For each `pub(super) async fn` in a Rust tool module, the levels that it
 * gives to `caller.book`. The body of a handler continues until the next
 * handler starts. A handler must call `caller.book` itself: a call in a
 * private helper is not seen, and the tool then has no gate.
 */
function rustHandlerLevels(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const starts = [...source.matchAll(/pub\(super\)\s+async\s+fn\s+(\w+)/g)];
  starts.forEach((start, i) => {
    const body = source.slice(start.index + start[0].length, starts[i + 1]?.index ?? source.length);
    const levels = [...body.matchAll(/\.book\(\s*[\w.]+\s*,\s*Level::(\w+)\s*\)/g)].map((m) =>
      m[1].toLowerCase()
    );
    result.set(start[1], levels);
  });
  return result;
}

/** Pair each Rust tool with the read-only hint of its manifest entry. */
function rustTools(
  dispatch: ReturnType<typeof rustDispatch>,
  modules: Map<string, string>,
  readOnly: Map<string, boolean>
): { tools: ToolLevel[]; problems: string[] } {
  const tools: ToolLevel[] = [];
  const problems: string[] = [];
  for (const { tool, module, handler } of dispatch) {
    const source = modules.get(module);
    const levels = source === undefined ? undefined : rustHandlerLevels(source).get(handler);
    const hint = readOnly.get(tool);
    if (levels === undefined) {
      problems.push(`${tool}: no handler ${module}::${handler} in ${RUST_TOOLS_DIR}`);
    } else if (hint === undefined) {
      problems.push(`${tool}: no manifest entry gives its annotations`);
    } else {
      tools.push({ tool, readOnly: hint, levels });
    }
  }
  return { tools, problems };
}

describe("Rust MCP tools declare their access level", () => {
  it("pairs every gated Rust tool with the level its annotations imply", () => {
    const readOnly = new Map(
      manifest.map((tool) => [tool.name, tool.annotations?.readOnlyHint === true] as const)
    );
    const modules = new Map(
      readdirSync(RUST_TOOLS_DIR)
        .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
        .map((f) => [f.replace(/\.rs$/, ""), readFileSync(join(RUST_TOOLS_DIR, f), "utf8")])
    );
    // Only the arms of call(): prepare() and precheck() also match on tool
    // names, but they run before the book gate.
    const modSource = readFileSync(join(RUST_TOOLS_DIR, "mod.rs"), "utf8");
    const dispatch = rustDispatch(modSource.slice(modSource.indexOf("pub(crate) async fn call(")));
    expect(dispatch.length).toBeGreaterThan(0);
    const { tools, problems } = rustTools(dispatch, modules, readOnly);
    expect([...problems, ...toolProblems(tools)]).toEqual([]);
  });
});

describe("Rust tool scan", () => {
  const thingsModule = `
    pub(super) async fn list(caller: &Caller, arguments: &Map<String, Value>) -> ToolResult<CallToolResult> {
        caller.book(book_id, Level::Read).await?;
    }
    pub(super) async fn create(caller: &Caller, arguments: &Map<String, Value>) -> ToolResult<CallToolResult> {
        caller.book(book_id, Level::Read).await?;
    }
    pub(super) async fn ungated(caller: &Caller) -> ToolResult<CallToolResult> {
        helper(caller).await?;
    }`;

  it("reads the dispatch and the level of each handler", () => {
    expect(rustDispatch(`"list_things" => things::list(caller, arguments).await,`)).toEqual([
      { tool: "list_things", module: "things", handler: "list" },
    ]);
    expect(rustHandlerLevels(thingsModule)).toEqual(
      new Map([
        ["list", ["read"]],
        ["create", ["read"]],
        ["ungated", []],
      ])
    );
  });

  it("reports a write tool at read, and a tool with no gate", () => {
    const dispatch = [
      { tool: "list_things", module: "things", handler: "list" },
      { tool: "create_thing", module: "things", handler: "create" },
      { tool: "sync_things", module: "things", handler: "ungated" },
      { tool: "gone_thing", module: "things", handler: "gone" },
      { tool: "unlisted_thing", module: "things", handler: "list" },
    ];
    const readOnly = new Map([
      ["list_things", true],
      ["create_thing", false],
      ["sync_things", false],
      ["gone_thing", false],
    ]);
    const { tools, problems } = rustTools(dispatch, new Map([["things", thingsModule]]), readOnly);
    expect(problems).toEqual([
      `gone_thing: no handler things::gone in ${RUST_TOOLS_DIR}`,
      "unlisted_thing: no manifest entry gives its annotations",
    ]);
    expect(toolProblems(tools)).toEqual([
      'create_thing (write): expected "write", found [read]',
      "sync_things: no caller.book call",
    ]);
  });

  it("reports a read-only tool that uses the write level", () => {
    expect(toolProblems([{ tool: "list_things", readOnly: true, levels: ["write"] }])).toEqual([
      'list_things (read-only): expected "read", found [write]',
    ]);
  });
});
