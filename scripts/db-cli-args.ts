export function shouldShowHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function parseRequiredBookId(args: string[], commandName: string): number {
  const bookIdIndex = args.indexOf("--book-id");

  if (bookIdIndex === -1 || !args[bookIdIndex + 1]) {
    throw new Error(`Error: --book-id <id> is required for ${commandName}`);
  }

  const bookId = Number.parseInt(args[bookIdIndex + 1], 10);
  if (!Number.isInteger(bookId) || bookId <= 0) {
    throw new Error("Error: --book-id must be a positive integer");
  }

  return bookId;
}

export function buildBookCommandHelp(
  commandName: string,
  description: string,
  usageSuffix = "",
  examples: string[] = []
): string {
  const exampleLines =
    examples.length === 0
      ? ""
      : `\nExamples:\n${examples.map((example) => `  ${example}`).join("\n")}\n`;

  const normalizedSuffix = usageSuffix ? ` ${usageSuffix}` : "";

  return `${description}

Usage:
  ${commandName} --book-id <id>${normalizedSuffix}

Options:
  --book-id <id>  Target book ID (required, positive integer)
  --help, -h      Show this help message${exampleLines}`;
}
