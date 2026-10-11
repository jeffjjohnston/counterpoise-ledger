// The contracts of the TransactionForm helpers that the component tests do
// not reach: the reconciled-edit warning, the restore of a simple, journal or
// split/capGain edit, the simple-entry messages, and the text trims of the
// payload. The investment payloads are pinned in
// TransactionFormInvestmentPayload.test.tsx.

import { describe, expect, it } from "vitest";
import {
  buildSimpleEntry,
  buildSubmitPayload,
  editFieldsFromTransaction,
  reconciledEditChanges,
  reconciledEditPrompt,
  type SubmitFields,
} from "@/components/transactions/transaction-form-fields";
import type { TransactionWithSplits } from "@/types";
import type { Account, InvestmentSplit } from "@/types/db";

const account = (id: number, overrides: Partial<Account> = {}): Account => ({
  id,
  bookId: 1,
  name: `Account ${id}`,
  type: "asset",
  subtype: null,
  parentId: null,
  isActive: true,
  isFavorite: false,
  isInvestmentCash: false,
  icon: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const brokerage = account(1, { subtype: "investment" });
const brokerageCash = account(2, { subtype: "cash", parentId: 1, isInvestmentCash: true });
const checking = account(3, { subtype: "bank" });
const groceries = account(4, { type: "expense" });
const fees = account(5, { type: "expense" });
const gains = account(6, { type: "income" });

const transaction = (
  splits: Array<[Account, number]>,
  investmentSplits: Array<Partial<InvestmentSplit>> = []
): TransactionWithSplits => ({
  id: 9,
  bookId: 1,
  date: "2024-06-10",
  description: null,
  checkNumber: null,
  notes: null,
  payeeId: null,
  isReconciled: false,
  isFloating: false,
  recurringRuleId: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  payee: null,
  splits: splits.map(([acct, amount], i) => ({
    id: i + 1,
    bookId: 1,
    transactionId: 9,
    accountId: acct.id,
    amount,
    account: acct,
  })),
  investmentSplits: investmentSplits.map((split, i) => ({
    id: i + 1,
    bookId: 1,
    transactionId: 9,
    accountId: 1,
    securityId: 10,
    action: "buy",
    sharesMicros: 0,
    priceMicros: 0,
    feesCents: 0,
    splitNumerator: null,
    splitDenominator: null,
    ...split,
  })),
});

describe("editFieldsFromTransaction", () => {
  it("restores a two-split entry as simple mode, debit to To and credit to From", () => {
    const fields = editFieldsFromTransaction(transaction([[checking, -1250], [groceries, 1250]]));

    expect(fields.mode).toBe("simple");
    expect(fields.simple).toEqual({ amount: "12.50", toAccountId: 4, fromAccountId: 3 });
    expect(fields.investment).toBeNull();
  });

  it("restores three splits as journal mode with no simple fields", () => {
    const fields = editFieldsFromTransaction(
      transaction([[checking, -3000], [groceries, 2000], [fees, 1000]])
    );

    expect(fields.mode).toBe("journal");
    expect(fields.simple).toBeNull();
    expect(fields.splits).toEqual([
      { accountId: 3, amount: -3000 },
      { accountId: 4, amount: 2000 },
      { accountId: 5, amount: 1000 },
    ]);
  });

  it("restores a buy with its shares, price and fee as text with no trailing zeros", () => {
    // 1.5 shares at $66.00 = $99.00, plus a $2.50 fee = $101.50 out of cash.
    const fields = editFieldsFromTransaction(
      transaction(
        [[brokerage, 9900], [fees, 250], [brokerageCash, -10150]],
        [{ action: "buy", sharesMicros: 1_500_000, priceMicros: 66_000_000, feesCents: 250 }]
      )
    );

    expect(fields.mode).toBe("investment");
    expect(fields.investment).toEqual({
      securityId: 10,
      action: "buy",
      shares: "1.5",
      price: "66",
      fee: "2.50",
      splitNumerator: "",
      splitDenominator: "",
      dividendAmount: undefined,
      capGainAmount: undefined,
      accountId: 1,
      incomeAccountId: undefined,
      feeAccountId: 5,
    });
  });

  it("restores a split ratio and takes the account from the cash parent", () => {
    const fields = editFieldsFromTransaction(
      transaction(
        [[brokerageCash, 0], [checking, 0]],
        [{ action: "split", splitNumerator: 3, splitDenominator: 2 }]
      )
    );

    expect(fields.investment).toMatchObject({
      action: "split",
      splitNumerator: "3",
      splitDenominator: "2",
      // The parent of Brokerage Cash.
      accountId: 1,
    });
  });

  it("restores a capital gain amount from the cash split", () => {
    const fields = editFieldsFromTransaction(
      transaction([[brokerageCash, 4321], [gains, -4321]], [{ action: "capGain" }])
    );

    expect(fields.investment).toMatchObject({
      capGainAmount: "43.21",
      dividendAmount: undefined,
      incomeAccountId: 6,
    });
  });

  it("restores more than one investment split as journal mode with no investment fields", () => {
    // Two buys in one transaction. Investment mode would show only the first
    // and replace both splits on save.
    const fields = editFieldsFromTransaction(
      transaction(
        [[brokerage, 15000], [brokerageCash, -15000]],
        [
          { action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000 },
          { action: "buy", sharesMicros: 1_000_000, priceMicros: 50_000_000 },
        ]
      )
    );

    expect(fields.mode).toBe("journal");
    expect(fields.investment).toBeNull();
    expect(fields.splits).toEqual([
      { accountId: 1, amount: 15000 },
      { accountId: 2, amount: -15000 },
    ]);
  });

  it("restores a reinvested dividend as Dividend Reinvest", () => {
    // $100.00 buys 1.5 shares at $65.00 with a $1.00 fee; $1.50 stays as cash.
    const fields = editFieldsFromTransaction(
      transaction(
        [[brokerage, 9750], [fees, 100], [gains, -10000], [brokerageCash, 150]],
        [
          { action: "dividend" },
          { action: "buy", sharesMicros: 1_500_000, priceMicros: 65_000_000, feesCents: 100 },
        ]
      )
    );

    expect(fields.mode).toBe("investment");
    expect(fields.investment).toEqual({
      securityId: 10,
      action: "reinvest",
      shares: "1.5",
      price: "65",
      fee: "1.00",
      splitNumerator: "",
      splitDenominator: "",
      dividendAmount: "100.00",
      accountId: 1,
      incomeAccountId: 6,
      feeAccountId: 5,
    });
  });

  it("restores a reinvested dividend in journal mode when the form would save other legs", () => {
    // An imported reinvestment keeps its fee in the investment leg; the form
    // would write a fee leg. A dividend and a buy of two securities is not a
    // reinvestment.
    for (const [splits, investmentSplits] of [
      [
        [[brokerage, 10100], [gains, -10100]],
        [{ action: "dividend" }, { action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000, feesCents: 100 }],
      ],
      [
        [[brokerage, 10000], [gains, -10000]],
        [{ action: "dividend", securityId: 11 }, { action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000 }],
      ],
      // The remainder went to the cash account of another brokerage; the form
      // would move it to the cash account of this one.
      [
        [[brokerage, 9750], [gains, -10000], [account(7, { subtype: "cash", parentId: 99, isInvestmentCash: true }), 250]],
        [{ action: "dividend" }, { action: "buy", sharesMicros: 1_500_000, priceMicros: 65_000_000 }],
      ],
    ] as Array<[Array<[Account, number]>, Array<Partial<InvestmentSplit>>]>) {
      const fields = editFieldsFromTransaction(transaction(splits, investmentSplits));
      expect(fields.mode).toBe("journal");
      expect(fields.investment).toBeNull();
    }
  });
});

describe("buildSimpleEntry", () => {
  it("debits To and credits From with the amount in cents", () => {
    expect(buildSimpleEntry("12.34", 3, 4)).toEqual({
      splits: [
        { accountId: 4, amount: 1234 },
        { accountId: 3, amount: -1234 },
      ],
    });
  });

  it("asks for both accounts before it looks at the amount", () => {
    expect(buildSimpleEntry("bad", null, 4)).toEqual({ error: "Please select both accounts" });
    expect(buildSimpleEntry("bad", 3, null)).toEqual({ error: "Please select both accounts" });
  });

  it("refuses a zero amount", () => {
    expect(buildSimpleEntry("0", 3, 4)).toEqual({ error: "Please enter an amount" });
  });
});

describe("reconciledEditChanges", () => {
  const original = {
    date: "2024-06-10",
    isReconciled: true,
    splits: [
      { accountId: 4, amount: 1250 },
      { accountId: 3, amount: -1250 },
    ],
  };

  it("finds no change when only the order of the splits differs", () => {
    expect(reconciledEditChanges(original, "2024-06-10", [...original.splits].reverse())).toEqual(
      []
    );
  });

  it("names the date, the splits, or both", () => {
    const moved = [
      { accountId: 5, amount: 1250 },
      { accountId: 3, amount: -1250 },
    ];
    expect(reconciledEditChanges(original, "2024-06-11", original.splits)).toEqual(["date"]);
    expect(reconciledEditChanges(original, "2024-06-10", moved)).toEqual(["amount/accounts"]);
    expect(reconciledEditChanges(original, "2024-06-10", original.splits.slice(0, 1))).toEqual([
      "amount/accounts",
    ]);
    expect(reconciledEditChanges(original, "2024-06-11", moved)).toEqual([
      "date",
      "amount/accounts",
    ]);
  });

  it("does not warn for a new or an unreconciled transaction", () => {
    expect(reconciledEditChanges(null, "2024-06-11", [])).toEqual([]);
    expect(reconciledEditChanges({ ...original, isReconciled: false }, "2024-06-11", [])).toEqual(
      []
    );
  });

  it("asks before it saves", () => {
    expect(reconciledEditPrompt(["date", "amount/accounts"])).toBe(
      "This transaction is reconciled. You are changing its date and amount/accounts.\n\nSave anyway?"
    );
  });
});

describe("buildSubmitPayload", () => {
  const fields: SubmitFields = {
    date: "2024-06-10",
    description: " Lunch ",
    notes: "  ",
    checkNumber: " 1234 ",
    payeeName: "  Blue Bottle ",
    isReconciled: false,
    isFloating: true,
    hasBankAccountInvolved: false,
  };
  const splits = [
    { accountId: 4, amount: 1250 },
    { accountId: 3, amount: -1250 },
  ];

  it("trims the payee, drops blank notes, and drops the check number without a bank account", () => {
    expect(buildSubmitPayload(fields, { splits })).toStrictEqual({
      date: "2024-06-10",
      description: " Lunch ",
      payeeName: "Blue Bottle",
      isReconciled: false,
      isFloating: true,
      splits,
      investmentSplits: undefined,
    });
  });

  it("sends trimmed notes and a trimmed check number when a bank account is in the entry", () => {
    const payload = buildSubmitPayload(
      { ...fields, notes: " paid in cash ", hasBankAccountInvolved: true },
      { splits }
    );

    expect(payload.notes).toBe("paid in cash");
    expect(payload.checkNumber).toBe("1234");
  });
});
