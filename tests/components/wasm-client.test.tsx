import { expect, it } from "vitest";
import { formatDate, validateSplits } from "@/lib/wasm-client";

it("loads the synchronous WASM core in the DOM test project", () => {
  expect(formatDate("2026-09-25")).toBe("Sep 25, 2026");
  expect(validateSplits([{ amount: 1 }, { amount: -1 }])).toBe(true);
});
