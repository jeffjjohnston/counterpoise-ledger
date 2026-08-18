import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDatabase, resetTestDatabase } from "../helpers/db";
import { importAccounts } from "@/scripts/import-moneydance/parsers/accounts";
import { IdMapper } from "@/scripts/import-moneydance/types";
import type { MoneydanceAccount } from "@/scripts/import-moneydance/types";
import { getDb } from "@/db";
import { accounts } from "@/db/schema";

const db = getDb();

describe("Account Import Integration", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("should import accounts with duplicate names under different parents", async () => {
    const mdAccounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "root",
        name: "Root",
        type: "r",
      },
      {
        obj_type: "acct",
        id: "auto",
        name: "Automobile",
        type: "e",
        parentid: "root",
      },
      {
        obj_type: "acct",
        id: "household",
        name: "Household",
        type: "e",
        parentid: "root",
      },
      {
        obj_type: "acct",
        id: "auto-maint",
        name: "Maintenance",
        type: "e",
        parentid: "auto",
      },
      {
        obj_type: "acct",
        id: "house-maint",
        name: "Maintenance",
        type: "e",
        parentid: "household",
      },
    ];

    const idMapper = new IdMapper();
    const options = {
      dryRun: false,
      importInactive: true,
      importHidden: true,
      verbose: false,
    };

    const result = await importAccounts(mdAccounts, idMapper, options, [], db, 1);

    // Should import 4 accounts (excluding root)
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1); // Root account
    expect(result.errors).toHaveLength(0);

    // Verify accounts were created with full path names
    const importedAccounts = await db.select().from(accounts);

    // Find the two maintenance accounts
    const autoMaintenance = importedAccounts.find(a => a.name === "Automobile:Maintenance");
    const houseMaintenance = importedAccounts.find(a => a.name === "Household:Maintenance");

    expect(autoMaintenance).toBeDefined();
    expect(houseMaintenance).toBeDefined();

    // Verify they have different IDs
    expect(autoMaintenance!.id).not.toBe(houseMaintenance!.id);

    // Verify parent accounts also have correct names
    const automobile = importedAccounts.find(a => a.name === "Automobile");
    const household = importedAccounts.find(a => a.name === "Household");

    expect(automobile).toBeDefined();
    expect(household).toBeDefined();

    // Verify parent relationships are set correctly
    expect(autoMaintenance!.parentId).toBe(automobile!.id);
    expect(houseMaintenance!.parentId).toBe(household!.id);
  });

  it("should handle nested hierarchies with full path names", async () => {
    const mdAccounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "root",
        name: "Root",
        type: "r",
      },
      {
        obj_type: "acct",
        id: "expenses",
        name: "Expenses",
        type: "e",
        parentid: "root",
      },
      {
        obj_type: "acct",
        id: "household",
        name: "Household",
        type: "e",
        parentid: "expenses",
      },
      {
        obj_type: "acct",
        id: "utilities",
        name: "Utilities",
        type: "e",
        parentid: "household",
      },
    ];

    const idMapper = new IdMapper();
    const options = {
      dryRun: false,
      importInactive: true,
      importHidden: true,
      verbose: false,
    };

    const result = await importAccounts(mdAccounts, idMapper, options, [], db, 1);

    expect(result.imported).toBe(3);
    expect(result.errors).toHaveLength(0);

    const importedAccounts = await db.select().from(accounts);

    // Verify the nested account has full path
    const utilities = importedAccounts.find(a => a.name === "Expenses:Household:Utilities");
    expect(utilities).toBeDefined();

    // Verify middle account has path
    const household = importedAccounts.find(a => a.name === "Expenses:Household");
    expect(household).toBeDefined();

    // Verify parent relationships
    expect(utilities!.parentId).toBe(household!.id);
  });

  it("should create investment cash accounts with full path names", async () => {
    const mdAccounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "root",
        name: "Root",
        type: "r",
      },
      {
        obj_type: "acct",
        id: "investments",
        name: "Investments",
        type: "a",
        parentid: "root",
      },
      {
        obj_type: "acct",
        id: "brokerage",
        name: "Brokerage",
        type: "v", // Investment account
        parentid: "investments",
      },
    ];

    const idMapper = new IdMapper();
    const options = {
      dryRun: false,
      importInactive: true,
      importHidden: true,
      verbose: false,
    };

    const result = await importAccounts(mdAccounts, idMapper, options, [], db, 1);

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);

    const importedAccounts = await db.select().from(accounts);

    // Verify investment account has full path
    const brokerage = importedAccounts.find(a => a.name === "Investments:Brokerage");
    expect(brokerage).toBeDefined();
    expect(brokerage!.subtype).toBe("investment");

    // Verify cash account also has full path
    const brokerageCash = importedAccounts.find(a => a.name === "Investments:Brokerage - Cash");
    expect(brokerageCash).toBeDefined();
    expect(brokerageCash!.subtype).toBe("cash");
    expect(brokerageCash!.isInvestmentCash).toBe(true);
    expect(brokerageCash!.parentId).toBe(brokerage!.id);

    // Verify idMapper has the cash account mapping
    const cashAccountId = idMapper.getAccount("brokerage_CASH");
    expect(cashAccountId).toBe(brokerageCash!.id);
  });

  it("should handle re-import idempotently (onConflictDoUpdate)", async () => {
    const mdAccounts: MoneydanceAccount[] = [
      {
        obj_type: "acct",
        id: "auto",
        name: "Automobile",
        type: "e",
      },
      {
        obj_type: "acct",
        id: "auto-maint",
        name: "Maintenance",
        type: "e",
        parentid: "auto",
      },
    ];

    const idMapper = new IdMapper();
    const options = {
      dryRun: false,
      importInactive: true,
      importHidden: true,
      verbose: false,
    };

    // First import
    const result1 = await importAccounts(mdAccounts, idMapper, options, [], db, 1);
    expect(result1.imported).toBe(2);
    expect(result1.errors).toHaveLength(0);

    const accountsAfterFirst = await db.select().from(accounts);
    expect(accountsAfterFirst).toHaveLength(2);

    // Second import (re-import same data)
    const idMapper2 = new IdMapper();
    const result2 = await importAccounts(mdAccounts, idMapper2, options, [], db, 1);
    expect(result2.imported).toBe(2);
    expect(result2.errors).toHaveLength(0);

    // Should still have only 2 accounts (no duplicates)
    const accountsAfterSecond = await db.select().from(accounts);
    expect(accountsAfterSecond).toHaveLength(2);

    // Account names should be the same
    const maintenance = accountsAfterSecond.find(a => a.name === "Automobile:Maintenance");
    expect(maintenance).toBeDefined();
  });
});
