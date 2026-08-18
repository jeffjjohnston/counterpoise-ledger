import { getDisplayBalance } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";

export type GroupDimension = "week" | "month" | "year" | "payee" | "account";

export type ReportSplit = {
  splitId: number;
  transactionId: number;
  date: string;
  amount: number;
  accountId: number;
  accountName: string;
  accountType: string;
  accountParentId: number | null;
  payeeId: number | null;
  payeeName: string | null;
};

export type ReportAccount = {
  id: number;
  name: string;
  type: string;
  parentId: number | null;
};

export type ReportGroupNode = {
  key: string;
  label: string;
  total: number;
  children: ReportGroupNode[];
  splits: ReportSplit[];
  depth: number;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function getMonday(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function extractKey(
  split: ReportSplit,
  dimension: GroupDimension,
  topParentMap: Map<number, number> | null,
  accountMap: Map<number, ReportAccount>,
): { key: string; label: string } {
  switch (dimension) {
    case "year": {
      const y = split.date.substring(0, 4);
      return { key: y, label: y };
    }
    case "month": {
      const ym = split.date.substring(0, 7);
      const monthIdx = parseInt(ym.substring(5, 7), 10) - 1;
      const year = ym.substring(0, 4);
      return { key: ym, label: `${MONTH_NAMES[monthIdx]} ${year}` };
    }
    case "week": {
      const monday = getMonday(split.date);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      const key = toDateString(monday);
      return {
        key,
        label: `Week of ${formatShortDate(monday)} – ${formatShortDate(sunday)}`,
      };
    }
    case "payee": {
      const name = split.payeeName || "(No payee)";
      const id = split.payeeId ?? 0;
      return { key: `payee:${id}`, label: name };
    }
    case "account": {
      let accountId = split.accountId;
      if (topParentMap) {
        accountId = topParentMap.get(accountId) ?? accountId;
      }
      const account = accountMap.get(accountId);
      const name = account?.name ?? `Account ${accountId}`;
      return { key: `account:${accountId}`, label: name };
    }
  }
}

function computeDisplayTotal(splits: ReportSplit[]): number {
  let total = 0;
  for (const s of splits) {
    total += getDisplayBalance(s.amount, s.accountType);
  }
  return total;
}

export function buildTopParentMap(
  accountMap: Map<number, ReportAccount>,
): Map<number, number> {
  const cache = new Map<number, number>();

  function resolve(id: number): number {
    if (cache.has(id)) return cache.get(id)!;
    const account = accountMap.get(id);
    if (!account || !account.parentId) {
      cache.set(id, id);
      return id;
    }
    const top = resolve(account.parentId);
    cache.set(id, top);
    return top;
  }

  for (const id of accountMap.keys()) {
    resolve(id);
  }
  return cache;
}

export function groupSplits(
  splits: ReportSplit[],
  dimensions: GroupDimension[],
  accountMap: Map<number, ReportAccount>,
  collapseToParent: boolean,
): ReportGroupNode[] {
  if (dimensions.length === 0) return [];

  const topParentMap = collapseToParent ? buildTopParentMap(accountMap) : null;

  function recurse(
    items: ReportSplit[],
    dims: GroupDimension[],
    depth: number,
    parentPath: string,
  ): ReportGroupNode[] {
    if (dims.length === 0) return [];

    const [dim, ...restDims] = dims;
    const groups = new Map<string, { label: string; splits: ReportSplit[] }>();
    const groupOrder: string[] = [];

    for (const split of items) {
      const { key, label } = extractKey(split, dim, topParentMap, accountMap);
      let group = groups.get(key);
      if (!group) {
        group = { label, splits: [] };
        groups.set(key, group);
        groupOrder.push(key);
      }
      group.splits.push(split);
    }

    // Sort group keys
    groupOrder.sort((a, b) => a.localeCompare(b));

    return groupOrder.map((key) => {
      const group = groups.get(key)!;
      const fullPath = parentPath ? `${parentPath}/${key}` : key;
      const children = recurse(group.splits, restDims, depth + 1, fullPath);
      return {
        key: fullPath,
        label: group.label,
        total: computeDisplayTotal(group.splits),
        children,
        splits: group.splits,
        depth,
      };
    });
  }

  return recurse(splits, dimensions, 0, "");
}

export function computeGrandTotal(splits: ReportSplit[]): number {
  return computeDisplayTotal(splits);
}
