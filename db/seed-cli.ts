/**
 * CLI entry for the sample-data seed. Run by `npm run db:seed`.
 *
 *   npm run db:seed                  Full destructive reset + seed (see seed()).
 *   npm run db:seed -- --book-id 2   Replace the contents of book 2 only.
 *
 * This file exists so db/seed.ts can stay side-effect free. db/seed.ts is
 * imported by application code (lib/books.ts → the demo-book route and the
 * create_demo_book MCP tool), and esbuild inlines everything it reaches into
 * dist/mcp-server.mjs. A main-module guard living in that module resolved
 * against the bundle's own path once inlined, so `node /app/mcp-server.mjs`
 * ran the destructive seed against production. Nothing imports THIS file, so
 * the guard below can only ever be true when a human runs it directly.
 */
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./index";
import * as schema from "./schema";
import { seed, seedBook } from "./seed";

export function runSeedCli(): Promise<number> {
  return seed()
    .then(() => 0)
    .catch((error) => {
      console.error("Seed failed:", error);
      return 1;
    });
}

async function main() {
  const args = process.argv.slice(2);
  const bookIdIndex = args.indexOf("--book-id");

  if (bookIdIndex !== -1) {
    const bookIdStr = args[bookIdIndex + 1];
    if (!bookIdStr) {
      console.error("Error: --book-id requires a numeric argument");
      process.exit(1);
    }
    const bookId = parseInt(bookIdStr, 10);
    if (isNaN(bookId)) {
      console.error(`Error: invalid book ID "${bookIdStr}"`);
      process.exit(1);
    }

    const db = getDb();

    // Verify book exists
    const [book] = await db
      .select({ id: schema.books.id, name: schema.books.name })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    if (!book) {
      console.error(`Error: book ${bookId} not found. Use 'npm run db:list-books' to see available books.`);
      process.exit(1);
    }

    // db/seed.ts's logSeed() stays private to that module; this line is the
    // only progress message the CLI adds, and the CLI is always an explicit
    // human invocation, so it prints unconditionally.
    console.log(`  Found book '${book.name}' (id: ${book.id})`);
    await seedBook(db, bookId);
  } else {
    const exitCode = await runSeedCli();
    process.exit(exitCode);
  }

  process.exit(0);
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
