import { formatCurrency, formatDate, toDateString } from "@/lib/formatters";
import { cn } from "@/lib/utils";

const MICROS_PER_SHARE = 1_000_000;

export type OpenLot = {
  lotId: number;
  accountId: number;
  accountName: string;
  acquiredDate: string;
  sharesMicros: number;
  basisCents: number;
};

type SecurityLotsTableProps = {
  lots: OpenLot[];
  /** Latest known price for the security, or null if none has been recorded. */
  latestPriceMicros: number | null;
};

const gainColorClass = (gainCents: number) =>
  gainCents > 0 ? "text-fg-success" : gainCents < 0 ? "text-fg-danger" : "text-fg-secondary";

// Matches TERM_BADGE_CLASS in app/b/[bookId]/reports/realized-gains/page.tsx so
// an open lot reads the same way here as it will once realized.
const TERM_BADGE_CLASS: Record<"short" | "long", string> = {
  short: "bg-surface-tertiary text-fg-secondary",
  long: "bg-accent-subtle text-fg-accent",
};

/**
 * True when the holding period exceeds one year (IRS long-term threshold),
 * measured from acquisition to today. Mirrors `isLongTerm` in
 * lib/realized-gains.ts (calendar-year comparison, not a 365-day
 * approximation) so an open lot's term here agrees with how it will be
 * classified once sold.
 *
 * Both sides of the comparison must be date-only (midnight UTC), not a live
 * timestamp — `Date.now()` carries a time of day, so comparing it directly
 * against midnight UTC on the anniversary date would flip the lot to "Long"
 * partway through the anniversary day itself, one day before
 * lib/realized-gains.ts (which compares two date-only values) agrees. That
 * mismatch would show "Long" here and "Short" on the realized gains report
 * for the same lot on the same day.
 */
const isLongTerm = (acquiredDate: string): boolean => {
  const acquired = new Date(`${acquiredDate}T00:00:00Z`);
  const oneYearLater = new Date(acquired);
  oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1);
  const today = new Date(`${toDateString(new Date())}T00:00:00Z`);
  return today.getTime() > oneYearLater.getTime();
};

export function SecurityLotsTable({ lots, latestPriceMicros }: SecurityLotsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-secondary text-fg-secondary">
          <tr>
            <th className="px-6 py-3 text-left font-medium">Acquired</th>
            <th className="px-6 py-3 text-left font-medium">Account</th>
            <th className="px-6 py-3 text-right font-medium">Shares</th>
            <th className="px-6 py-3 text-right font-medium">Cost Basis</th>
            <th className="px-6 py-3 text-right font-medium">Basis/Share</th>
            <th className="px-6 py-3 text-right font-medium">Value</th>
            <th className="px-6 py-3 text-right font-medium">Unrealized</th>
            <th className="px-6 py-3 text-left font-medium">Term</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-secondary">
          {lots.length === 0 ? (
            <tr>
              <td className="px-6 py-8 text-center text-fg-tertiary" colSpan={8}>
                No open lots.
              </td>
            </tr>
          ) : (
            lots.map((lot) => {
              const shares = lot.sharesMicros / MICROS_PER_SHARE;
              const valueCents =
                latestPriceMicros === null
                  ? null
                  : Math.round(shares * (latestPriceMicros / MICROS_PER_SHARE) * 100);
              const unrealizedCents = valueCents === null ? null : valueCents - lot.basisCents;
              const term = isLongTerm(lot.acquiredDate) ? "long" : "short";

              return (
                <tr key={lot.lotId}>
                  <td className="px-6 py-4 text-fg-secondary">{formatDate(lot.acquiredDate)}</td>
                  <td className="px-6 py-4 text-fg-secondary">{lot.accountName}</td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {shares.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {formatCurrency(lot.basisCents)}
                  </td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {shares > 0 ? formatCurrency(Math.round(lot.basisCents / shares)) : "—"}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-fg tabular-nums">
                    {valueCents === null ? "—" : formatCurrency(valueCents)}
                  </td>
                  <td
                    className={`px-6 py-4 text-right font-medium tabular-nums ${
                      unrealizedCents === null ? "text-fg-secondary" : gainColorClass(unrealizedCents)
                    }`}
                  >
                    {unrealizedCents === null ? "—" : formatCurrency(unrealizedCents)}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                        TERM_BADGE_CLASS[term]
                      )}
                    >
                      {term === "long" ? "Long" : "Short"}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
