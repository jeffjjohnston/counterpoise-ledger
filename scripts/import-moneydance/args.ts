import type { ImportOptions } from "./types";

export interface ParsedImportArgs {
  filePath: string;
  bookId: number;
  overwrite: boolean;
  options: ImportOptions;
}

export function shouldShowHelp(args: string[]): boolean {
  return args.length === 0 || args[0] === "--help" || args[0] === "-h";
}

export function parseImportArgs(args: string[]): ParsedImportArgs {
  if (!args[0] || args[0].startsWith("--")) {
    throw new Error("Error: <path-to-json> is required");
  }

  const bookIdIndex = args.indexOf("--book-id");
  if (bookIdIndex === -1 || !args[bookIdIndex + 1]) {
    throw new Error("Error: --book-id <id> is required");
  }

  const bookId = Number.parseInt(args[bookIdIndex + 1], 10);
  if (!Number.isInteger(bookId) || bookId <= 0) {
    throw new Error("Error: --book-id must be a positive integer");
  }

  const filePath = args[0];

  return {
    filePath,
    bookId,
    overwrite: args.includes("--overwrite"),
    options: {
      dryRun: args.includes("--dry-run"),
      importInactive: !args.includes("--no-inactive"),
      importHidden: !args.includes("--no-hidden"),
      verbose: args.includes("--verbose"),
    },
  };
}
