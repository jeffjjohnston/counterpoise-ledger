import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./register-all.js";
import { initMcpAuth } from "./auth.js";

const server = new McpServer({
  name: "counterpoise",
  version: "1.0.0",
});

registerAllTools(server);

async function main() {
  const auth = await initMcpAuth();
  if (auth) {
    console.error(`MCP authenticated as user ${auth.userId}`);
  } else {
    console.error("No valid API key — all tools will require COUNTERPOISE_API_KEY to be set");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
