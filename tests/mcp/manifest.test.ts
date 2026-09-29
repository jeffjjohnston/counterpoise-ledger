import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "@/rust-api/server/mcp-tools.json";
import { setupTestDatabase } from "@/tests/helpers/db-utils";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";

type ManifestTool = { name: string; execution?: unknown } & Record<string, unknown>;

/**
 * `rust-api/server/mcp-tools.json` is the source of each tool's name, title,
 * description, annotations and input schema. The Rust server reads it at build
 * time, so what a client sees is what the file says.
 */
describe("MCP tool manifest", () => {
  it("lists each tool once, in name order", () => {
    const names = (manifest as ManifestTool[]).map((tool) => tool.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, "en")));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("tools/list", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    await setupTestDatabase();
    mcp = await connectMcpTestClient();
  }, 120_000);

  afterAll(async () => {
    await mcp.close();
  });

  it("describes each tool exactly as the manifest does", async () => {
    const { tools } = await mcp.client.listTools();
    // rmcp has no field for `execution`, and its default is the absent value.
    const withoutExecution = (entry: ManifestTool) =>
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "execution"));
    expect((tools as ManifestTool[]).map(withoutExecution)).toEqual(
      (manifest as ManifestTool[]).map(withoutExecution)
    );
  });
});
