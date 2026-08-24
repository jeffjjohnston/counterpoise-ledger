import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "@/mcp/register-all";

const TOOLS_DIR = resolve(__dirname, "../../mcp/tools");

/** Tool module files. Leading-underscore files are shared helpers, not modules. */
function toolModuleFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts"))
    .sort();
}

async function toolNamesOf(register: (s: McpServer) => void): Promise<string[]> {
  const server = new McpServer({ name: "probe", version: "1.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe("registerAllTools coverage", () => {
  it("registers every tool module under mcp/tools/", async () => {
    const all = new Set(await toolNamesOf(registerAllTools));
    const orphaned: string[] = [];

    for (const file of toolModuleFiles()) {
      // Stripping ".ts" and appending it back is a no-op on the string itself.
      // It exists so the ".ts" after the interpolation is a literal token, which
      // is what keeps Vite's dynamic-import-vars plugin able to statically
      // analyse this import; a bare `${file}` fails that analysis.
      const mod = await import(`@/mcp/tools/${file.replace(/\.ts$/, "")}.ts`);
      // Assumes each tool module exports exactly one register*Tools function.
      // Nothing enforces that; a module with two would silently pick the first.
      const register = Object.entries(mod).find(
        ([name, value]) => name.startsWith("register") && typeof value === "function"
      )?.[1] as ((s: McpServer) => void) | undefined;

      expect(register, `${file} exports no register*Tools function`).toBeDefined();

      const owned = await toolNamesOf(register!);
      expect(owned.length, `${file} registers no tools`).toBeGreaterThan(0);
      if (!owned.every((name) => all.has(name))) {
        orphaned.push(`${file} (${owned.filter((n) => !all.has(n)).join(", ")})`);
      }
    }

    expect(
      orphaned,
      "These modules are not wired into mcp/register-all.ts, so server.ts and every test that uses registerAllTools cannot see them."
    ).toEqual([]);
  });
});
