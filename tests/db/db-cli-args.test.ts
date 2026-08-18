import { describe, expect, it } from "vitest";
import { parseRequiredBookId } from "@/scripts/db-cli-args";

describe("db-cli-args", () => {
  it("parses a valid --book-id", () => {
    expect(parseRequiredBookId(["--book-id", "42"], "db:push")).toBe(42);
  });

  it("throws when --book-id is missing", () => {
    expect(() => parseRequiredBookId([], "db:push")).toThrow(
      "Error: --book-id <id> is required for db:push"
    );
  });

  it("throws when --book-id is not a positive integer", () => {
    expect(() => parseRequiredBookId(["--book-id", "0"], "db:push")).toThrow(
      "Error: --book-id must be a positive integer"
    );
    expect(() => parseRequiredBookId(["--book-id", "-5"], "db:push")).toThrow(
      "Error: --book-id must be a positive integer"
    );
    expect(() => parseRequiredBookId(["--book-id", "abc"], "db:push")).toThrow(
      "Error: --book-id must be a positive integer"
    );
  });
});
