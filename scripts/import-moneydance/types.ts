/**
 * Type definitions for Moneydance import
 */

export interface MoneydanceExport {
  metadata: {
    exporter: string;
    moneydance_build: number;
    export_date: number;
    file_name: string;
  };
  all_items: MoneydanceItem[];
}

export interface MoneydanceItem {
  obj_type: string;
  id: string;
  [key: string]: unknown;
}

export interface MoneydanceAccount extends MoneydanceItem {
  obj_type: "acct";
  name: string;
  type: string;
  parentid?: string;
  currid?: string;
  curr?: string;
  is_inactive?: string;
  hide?: string;
  creation_date?: string;
  comment?: string;
  // Initial balance field
  sbal?: string;
  // Loan-specific fields
  init_principal?: string;
  monthly_pmt?: string;
  num_payments?: string;
  // Security-specific fields
  sec_type?: string;
  ticker?: string;
}

export interface MoneydanceTransaction extends MoneydanceItem {
  obj_type: "txn";
  dt: string;
  desc: string;
  acctid: string;
  stat?: string;
  chk?: string;
  xfer_type?: string;
  reinvest?: string;
  "invest.txntype"?: string;
  // Numbered splits (0.*, 1.*, 2.*, etc.)
  [key: `${number}.${string}`]: unknown;
}

export interface MoneydanceSecurityPrice extends MoneydanceItem {
  obj_type: "csnap";
  curr: string;
  dt: string;
  relrt: string;
}

export interface MoneydanceStockSplit extends MoneydanceItem {
  obj_type: "csplit";
  curr: string;
  dt: string;
  oldshrs: string;
  newshrs: string;
  ratio: string;
}

export interface MoneydanceReminder extends MoneydanceItem {
  obj_type: "reminder";
  desc: string;
  type?: string;
  sdt: string;          // Start date (YYYYMMDD)
  ackdt: string;        // Next occurrence date (YYYYMMDD)
  ldt?: string;         // Last processed date ("0" = never)
  acdays?: string;      // Auto-commit days before
  is_loan_reminder?: string;
  // Frequency flags
  daily?: string;
  weekly?: string;
  weeklymod?: string;
  weeklydays?: string;
  monthly?: string;
  monthlymod?: string;
  monthlydays?: string;
  day_of_month_mod?: string;
  yearly?: string;
  // Embedded transaction template (txn.* prefixed fields)
  [key: `txn.${string}`]: unknown;
}

export interface AccountMapping {
  type: "asset" | "liability" | "equity" | "income" | "expense";
  subtype?: "bank" | "credit_card" | "loan" | "investment" | "cash" | "other";
}

export interface ImportStats {
  accounts: {
    total: number;
    imported: number;
    skipped: number;
    securities: number;
  };
  payees: {
    total: number;
    imported: number;
  };
  transactions: {
    total: number;
    imported: number;
    skipped: number;
    splits: number;
  };
  investmentTransactions?: {
    total: number;
    imported: number;
    skipped: number;
    buys: number;
    sells: number;
    dividends: number;
    lots: number;
    orphanedSells: number;
  };
  securityPrices?: {
    total: number;
    imported: number;
    skipped: number;
  };
  stockSplits?: {
    total: number;
    imported: number;
    skipped: number;
  };
}

export interface ImportOptions {
  dryRun: boolean;
  importInactive: boolean;
  importHidden: boolean;
  verbose: boolean;
}

export interface TransactionSplit {
  splitType: string;
  samt?: number; // Shares in micros (for "sec" splits)
  pamt?: number; // Cash amount in cents
  acctid?: string;
  secid?: string; // Security ID (for "sec" splits)
}

export interface InvestmentLot {
  id: number;
  securityId: number;
  openedTransactionId: number | null;
  closedTransactionId: number | null;
  createdAt: Date;
  // Fields tracked during import for FIFO matching (not in DB)
  accountId: number;
  remainingShares: number;
}

export class IdMapper {
  private accountMap = new Map<string, number>();
  private payeeMap = new Map<string, number>();
  private securityMap = new Map<string, number>();

  setAccount(mdId: string, cpId: number): void {
    this.accountMap.set(mdId, cpId);
  }

  getAccount(mdId: string): number | undefined {
    return this.accountMap.get(mdId);
  }

  hasAccount(mdId: string): boolean {
    return this.accountMap.has(mdId);
  }

  setPayee(name: string, cpId: number): void {
    this.payeeMap.set(name, cpId);
  }

  getPayee(name: string): number | undefined {
    return this.payeeMap.get(name);
  }

  setSecurity(mdId: string, cpId: number): void {
    this.securityMap.set(mdId, cpId);
  }

  getSecurity(mdId: string): number | undefined {
    return this.securityMap.get(mdId);
  }

  getStats() {
    return {
      accounts: this.accountMap.size,
      payees: this.payeeMap.size,
      securities: this.securityMap.size,
    };
  }
}
