import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBooksTools } from "./tools/books.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerReportTools } from "./tools/reports.js";
import { registerInvestmentTools } from "./tools/investments.js";
import { registerSecurityTools } from "./tools/securities.js";
import { registerUsageTools } from "./tools/usage.js";
import { initMcpAuth } from "./auth.js";
import { registerWriteTransactionTools } from "./tools/write-transactions.js";

const server = new McpServer({
  name: "counterpoise",
  version: "1.0.0",
});

registerBooksTools(server);
registerAccountTools(server);
registerTransactionTools(server);
registerReportTools(server);
registerInvestmentTools(server);
registerSecurityTools(server);
registerUsageTools(server);

async function main() {
  const auth = await initMcpAuth();
  if (auth) {
    console.error(`MCP authenticated as user ${auth.userId}`);
  } else {
    console.error("No valid API key — all tools will require COUNTERPOISE_API_KEY to be set");
  }

  registerWriteTransactionTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
