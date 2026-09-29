import { describe, expect, it } from "vitest";
import { accessDeniedMessage, roleSatisfies } from "@/lib/book-roles";

describe("roleSatisfies", () => {
  it.each([
    ["owner", "read", true], ["owner", "write", true], ["owner", "owner", true],
    ["editor", "read", true], ["editor", "write", true], ["editor", "owner", false],
    ["viewer", "read", true], ["viewer", "write", false], ["viewer", "owner", false],
  ] as const)("%s at %s is %s", (role, level, expected) => {
    expect(roleSatisfies(role, level)).toBe(expected);
  });
});

describe("accessDeniedMessage", () => {
  it("names read-only access for write", () => {
    expect(accessDeniedMessage("write")).toBe("You have read-only access to this book");
  });
  it("names the owner for owner", () => {
    expect(accessDeniedMessage("owner")).toBe("Only an owner can do this");
  });
});
