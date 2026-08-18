import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { requireAuth } from "@/mcp/auth";

export function registerBooksTools(server: McpServer) {
  server.registerTool("list_books", {
    title: "List Books",
    description:
      "List your accounting books in Counterpoise. Returns book IDs, names, and creation dates. Use this first to discover which bookId to pass to other tools. Requires a valid API key.",
    inputSchema: {},
  }, async () => {
    const auth = await requireAuth();
    if ("isError" in auth) return auth;

    const db = getDb();
    const userBooks = await db
      .select({ id: books.id, name: books.name, createdAt: books.createdAt })
      .from(books)
      .where(eq(books.userId, auth.userId));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(userBooks, null, 2),
        },
      ],
    };
  });
}
