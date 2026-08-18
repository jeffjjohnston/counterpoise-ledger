/**
 * The fixture this guards replaced a real Moneydance export that carried a card
 * number, bank account numbers, an OFX username, and an AlphaVantage API key.
 * These assertions keep the replacement honest on every CI run rather than only
 * at review time.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_PATH = path.join(process.cwd(), "tests/fixtures/moneydance-sample.json");

let raw: string;
let parsed: { metadata: Record<string, unknown>; all_items: Array<Record<string, unknown>> };

beforeAll(async () => {
  raw = await readFile(FIXTURE_PATH, "utf-8");
  parsed = JSON.parse(raw);
});

describe("import fixture privacy", () => {
  it("contains no runs of nine or more digits", () => {
    // Account, card, and routing numbers. Dates are 8 digits (20240115) and the
    // largest cent amount is 8 (32500000), so nothing legitimate reaches nine.
    expect(raw.match(/\d{9,}/g)).toBeNull();
  });

  it("contains no email addresses or OFX identifiers", () => {
    expect(raw).not.toContain("@");
    expect(raw).not.toContain("ofx");
    expect(raw).not.toContain("netsync");
    expect(raw).not.toContain("apikey");
  });

  it("contains no personal filesystem paths", () => {
    const paths = raw.match(/\/Users\/[a-zA-Z0-9._-]+/g) ?? [];
    expect(paths).toEqual([]);
  });

  it("carries only the metadata fields the importer reads", () => {
    expect(Object.keys(parsed.metadata).sort()).toEqual([
      "export_date",
      "exporter",
      "file_name",
      "moneydance_build",
    ]);
  });
});

describe("import fixture census", () => {
  it("has the expected object-type distribution", () => {
    const counts: Record<string, number> = {};
    for (const item of parsed.all_items) {
      const type = item.obj_type as string;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      curr: 4,
      acct: 17,
      txn: 12,
      csnap: 6,
      csplit: 1,
      reminder: 2,
    });
    expect(parsed.all_items).toHaveLength(42);
  });

  it("covers every account type mapAccountType handles", () => {
    const types = new Set(
      parsed.all_items
        .filter((i) => i.obj_type === "acct")
        .map((i) => i.type as string)
    );
    expect([...types].sort()).toEqual(["a", "b", "c", "e", "i", "l", "o", "r", "s", "v"]);
  });

  it("uses readable IDs, not UUIDs", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const item of parsed.all_items) {
      expect(item.id as string).not.toMatch(uuid);
    }
  });
});
