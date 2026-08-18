type PlaidEnv = "sandbox" | "development" | "production";

const PLAID_BASE_URLS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

type PlaidErrorResponse = {
  error_message?: string;
  error_code?: string;
  error_type?: string;
};

type PlaidAccountsGetResponse = {
  accounts?: PlaidAccountSummary[];
};

type PlaidTransactionsSyncResponse = {
  added?: PlaidTransactionSyncItem[];
  modified?: PlaidTransactionSyncItem[];
  removed?: PlaidTransactionRemovedItem[];
  has_more?: boolean;
  next_cursor?: string | null;
};

export type PlaidAccountSummary = {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
};

export type PlaidTransactionSyncItem = {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  category: string[] | null;
  personal_finance_category: {
    primary: string;
    detailed: string;
  } | null;
  pending: boolean;
  pending_transaction_id: string | null;
  authorized_date: string | null;
  date: string;
  name: string;
  merchant_name: string | null;
  original_description: string | null;
};

export type PlaidTransactionRemovedItem = {
  transaction_id: string;
};

export type PlaidTransactionsSyncPage = {
  added: PlaidTransactionSyncItem[];
  modified: PlaidTransactionSyncItem[];
  removed: PlaidTransactionRemovedItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

type PlaidConfig = {
  clientId: string;
  secret: string;
  baseUrl: string;
};

type FetchPlaidTransactionsSyncParams = {
  accessToken: string;
  cursor?: string | null;
  count?: number;
  daysRequested?: number;
};

function parsePlaidEnv(value: string | undefined): PlaidEnv | null {
  if (!value) return null;
  if (value === "sandbox" || value === "development" || value === "production") {
    return value;
  }
  return null;
}

function getPlaidConfig(): PlaidConfig {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const plaidEnv = parsePlaidEnv(process.env.PLAID_ENV);

  if (!clientId) {
    throw new Error("PLAID_CLIENT_ID environment variable not configured");
  }

  if (!secret) {
    throw new Error("PLAID_SECRET environment variable not configured");
  }

  if (!plaidEnv) {
    throw new Error(
      "PLAID_ENV environment variable must be one of sandbox, development, or production"
    );
  }

  return {
    clientId,
    secret,
    baseUrl: PLAID_BASE_URLS[plaidEnv],
  };
}

function formatPlaidError(prefix: string, payload: PlaidErrorResponse | null): string {
  if (!payload?.error_message) {
    return prefix;
  }

  const codeSuffix = payload.error_code ? ` (${payload.error_code})` : "";
  return `${prefix}: ${payload.error_message}${codeSuffix}`;
}

export async function fetchPlaidAccounts(
  accessToken: string
): Promise<PlaidAccountSummary[]> {
  const { clientId, secret, baseUrl } = getPlaidConfig();

  const response = await fetch(`${baseUrl}/accounts/get`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      access_token: accessToken,
    }),
  });

  if (!response.ok) {
    let payload: PlaidErrorResponse | null = null;
    try {
      payload = (await response.json()) as PlaidErrorResponse;
    } catch {
      payload = null;
    }
    throw new Error(formatPlaidError("Plaid /accounts/get request failed", payload));
  }

  const payload = (await response.json()) as PlaidAccountsGetResponse;
  if (!Array.isArray(payload.accounts)) {
    throw new Error("Plaid /accounts/get returned an invalid accounts payload");
  }

  return payload.accounts;
}

function isSyncItem(value: unknown): value is PlaidTransactionSyncItem {
  const item = value as Partial<PlaidTransactionSyncItem> | null;
  if (!item || typeof item !== "object") return false;
  return (
    typeof item.transaction_id === "string" &&
    typeof item.account_id === "string" &&
    typeof item.amount === "number" &&
    typeof item.date === "string" &&
    typeof item.name === "string" &&
    typeof item.pending === "boolean"
  );
}

function isRemovedItem(value: unknown): value is PlaidTransactionRemovedItem {
  const item = value as Partial<PlaidTransactionRemovedItem> | null;
  return !!item && typeof item === "object" && typeof item.transaction_id === "string";
}

export async function fetchPlaidTransactionsSync(
  params: FetchPlaidTransactionsSyncParams
): Promise<PlaidTransactionsSyncPage> {
  const { clientId, secret, baseUrl } = getPlaidConfig();
  const options: Record<string, unknown> = {};

  if (typeof params.daysRequested === "number") {
    options.days_requested = params.daysRequested;
  }

  const body: Record<string, unknown> = {
    client_id: clientId,
    secret,
    access_token: params.accessToken,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };

  if (params.cursor) {
    body.cursor = params.cursor;
  }

  if (typeof params.count === "number") {
    body.count = params.count;
  }

  const response = await fetch(`${baseUrl}/transactions/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let payload: PlaidErrorResponse | null = null;
    try {
      payload = (await response.json()) as PlaidErrorResponse;
    } catch {
      payload = null;
    }
    throw new Error(
      formatPlaidError("Plaid /transactions/sync request failed", payload)
    );
  }

  const payload = (await response.json()) as PlaidTransactionsSyncResponse;
  const added = Array.isArray(payload.added) ? payload.added.filter(isSyncItem) : [];
  const modified = Array.isArray(payload.modified)
    ? payload.modified.filter(isSyncItem)
    : [];
  const removed = Array.isArray(payload.removed)
    ? payload.removed.filter(isRemovedItem)
    : [];

  if (typeof payload.has_more !== "boolean") {
    throw new Error("Plaid /transactions/sync returned invalid has_more");
  }

  if (payload.next_cursor !== null && typeof payload.next_cursor !== "string") {
    throw new Error("Plaid /transactions/sync returned invalid next_cursor");
  }

  return {
    added,
    modified,
    removed,
    hasMore: payload.has_more,
    nextCursor: payload.next_cursor ?? null,
  };
}
