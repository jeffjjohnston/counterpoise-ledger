import { describe, it, expect } from "vitest";
import { comparePayeeMatches, rankPayeeMatch } from "@/lib/payee-match";

describe("rankPayeeMatch", () => {
  it("ranks a name that starts with the term first", () => {
    expect(rankPayeeMatch("United Airlines", "uni")).toBe(0);
  });

  it("ranks a name with a word that starts with the term second", () => {
    expect(rankPayeeMatch("Credit Union", "uni")).toBe(1);
  });

  it("ranks any other substring match last", () => {
    expect(rankPayeeMatch("Reunion Hall", "uni")).toBe(2);
  });

  it("ignores case on both sides", () => {
    expect(rankPayeeMatch("UNITED", "Uni")).toBe(0);
    expect(rankPayeeMatch("credit UNION", "uni")).toBe(1);
  });

  it("treats an empty term as a prefix match", () => {
    expect(rankPayeeMatch("Anything", "")).toBe(0);
  });
});

describe("comparePayeeMatches", () => {
  it("orders by rank, then by name", () => {
    const names = ["Reunion Hall", "Credit Union", "United Airlines", "Union Square Cafe"];
    const sorted = [...names].sort((a, b) => comparePayeeMatches(a, b, "uni"));
    expect(sorted).toEqual([
      "Union Square Cafe",
      "United Airlines",
      "Credit Union",
      "Reunion Hall",
    ]);
  });
});
