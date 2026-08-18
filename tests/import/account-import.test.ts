import { describe, it, expect } from "vitest";
import { buildAccountFullPath } from "@/scripts/import-moneydance/parsers/accounts";
import type { MoneydanceAccount } from "@/scripts/import-moneydance/types";

describe("buildAccountFullPath", () => {
  it("should return just the account name for top-level accounts", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "1",
        name: "Expenses",
        type: "e",
      },
    ];

    const result = buildAccountFullPath(accounts[0], accounts);
    expect(result).toBe("Expenses");
  });

  it("should build path for account with one parent", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "1",
        name: "Automobile",
        type: "e",
      },
      {
        obj_type: "acct",
        id: "2",
        name: "Maintenance",
        type: "e",
        parentid: "1",
      },
    ];

    const result = buildAccountFullPath(accounts[1], accounts);
    expect(result).toBe("Automobile:Maintenance");
  });

  it("should build path for account with multiple parents (nested hierarchy)", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "1",
        name: "Expenses",
        type: "e",
      },
      {
        obj_type: "acct",
        id: "2",
        name: "Household",
        type: "e",
        parentid: "1",
      },
      {
        obj_type: "acct",
        id: "3",
        name: "Utilities",
        type: "e",
        parentid: "2",
      },
    ];

    const result = buildAccountFullPath(accounts[2], accounts);
    expect(result).toBe("Expenses:Household:Utilities");
  });

  it("should handle accounts with the same name under different parents", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "1",
        name: "Automobile",
        type: "e",
      },
      {
        obj_type: "acct",
        id: "2",
        name: "Household",
        type: "e",
      },
      {
        obj_type: "acct",
        id: "3",
        name: "Maintenance",
        type: "e",
        parentid: "1",
      },
      {
        obj_type: "acct",
        id: "4",
        name: "Maintenance",
        type: "e",
        parentid: "2",
      },
    ];

    const result1 = buildAccountFullPath(accounts[2], accounts);
    const result2 = buildAccountFullPath(accounts[3], accounts);

    expect(result1).toBe("Automobile:Maintenance");
    expect(result2).toBe("Household:Maintenance");
    // Verify they are different
    expect(result1).not.toBe(result2);
  });

  it("should stop at root account (type 'r')", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "root",
        name: "Root",
        type: "r",
      },
      {
        obj_type: "acct",
        id: "1",
        name: "Expenses",
        type: "e",
        parentid: "root",
      },
      {
        obj_type: "acct",
        id: "2",
        name: "Maintenance",
        type: "e",
        parentid: "1",
      },
    ];

    const result = buildAccountFullPath(accounts[2], accounts);
    // Should not include "Root" in the path
    expect(result).toBe("Expenses:Maintenance");
  });

  it("should handle account with no parent ID", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "1",
        name: "Checking",
        type: "b",
        // No parentid field
      },
    ];

    const result = buildAccountFullPath(accounts[0], accounts);
    expect(result).toBe("Checking");
  });

  it("should handle broken hierarchy (missing parent)", () => {
    const accounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "2",
        name: "Maintenance",
        type: "e",
        parentid: "999", // Parent doesn't exist
      },
    ];

    const result = buildAccountFullPath(accounts[0], accounts);
    // Should just return the account name when parent is missing
    expect(result).toBe("Maintenance");
  });
});
