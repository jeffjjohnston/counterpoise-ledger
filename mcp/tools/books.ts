import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import {
  createBook,
  updateBook,
  deleteBook,
  createDemoBook,
  BookValidationError,
  BookNotFoundError,
} from "@/lib/books";
import { createBookSchema, updateBookSchema } from "@/lib/schemas/books";
import { requireAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ, UPDATE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";

export function registerBooksTools(server: McpServer) {
  server.registerTool("list_books", {
    title: "List Books",
    description:
      "List your accounting books in Counterpoise. Returns book IDs, names, and creation dates. Use this first to discover which bookId to pass to other tools. Requires a valid API key.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const auth = await requireAuth();
    if ("isError" in auth) return auth;

    const db = getDb();
    const userBooks = await db
      .select({ id: books.id, name: books.name, createdAt: books.createdAt })
      .from(books)
      .where(eq(books.userId, auth.userId));
    return ok(userBooks);
  });

  server.registerTool(
    "create_book",
    {
      title: "Create Book",
      description:
        "Create a new accounting book for the authenticated user. A book is the top-level " +
        "container for a ledger — every account, transaction, security and bank connection " +
        "belongs to one.",
      inputSchema: { ...toolShape(createBookSchema) },
      annotations: CREATE,
    },
    async (input) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      return ok(await createBook(getDb(), auth.userId, input));
    }
  );

  server.registerTool(
    "update_book",
    {
      title: "Update Book",
      description:
        "Rename a book, and optionally change how many days ahead it projects recurring " +
        "transactions. name is always required — to change only upcomingDays, resend the " +
        "book's current name. Use list_books to read it and to find a bookId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to update"),
        ...toolShape(updateBookSchema),
      },
      annotations: UPDATE,
    },
    async ({ bookId, ...input }) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      try {
        return ok(await updateBook(getDb(), auth.userId, bookId, input));
      } catch (error) {
        if (error instanceof BookNotFoundError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "create_demo_book",
    {
      title: "Create Demo Book",
      description:
        "Create a new book and fill it with realistic sample data — about three years of " +
        "transactions across dozens of accounts, payees and securities — for exploring " +
        "Counterpoise. Named 'Demo Book', or 'Demo Book 2', 'Demo Book 3', etc. if that name " +
        "is already taken. This writes thousands of rows and can take several seconds.",
      inputSchema: {},
      annotations: CREATE,
    },
    async () => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      return ok(await createDemoBook(getDb(), auth.userId));
    }
  );

  server.registerTool(
    "delete_book",
    {
      title: "Delete Book",
      description:
        "Permanently delete a book and ALL of its data — every account, transaction, split, " +
        "security, price, lot, recurring rule, payee and bank connection in it. This cannot be undone. " +
        "You must pass confirmBookName exactly matching the book's name; use list_books to read it first. " +
        "Do not call this unless the user has explicitly asked to delete this specific book.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to delete"),
        confirmBookName: z
          .string()
          .min(1)
          .describe("The book's exact name, as a confirmation that this deletion is intended"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, confirmBookName }) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      try {
        await deleteBook(getDb(), auth.userId, bookId, confirmBookName);
        return ok({ success: true, bookId });
      } catch (error) {
        if (error instanceof BookValidationError || error instanceof BookNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );
}
