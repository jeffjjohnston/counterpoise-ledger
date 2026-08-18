import Link from "next/link";
import { formatCurrency } from "@/lib/formatters";
import type { PositionSummary } from "@/lib/investments";

const formatShares = (sharesMicros: number) =>
  (sharesMicros / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });

const formatPrice = (priceMicros: number | null) => {
  if (priceMicros === null) return "—";
  const cents = Math.round(priceMicros / 10_000);
  return formatCurrency(cents);
};

type PositionsTableProps = {
  positions: PositionSummary[];
  cashBalanceCents?: number;
  bookId?: string;
};

export function PositionsTable({
  positions,
  cashBalanceCents,
  bookId,
}: PositionsTableProps) {
  const showTotals = cashBalanceCents !== undefined;
  const investmentTotalCents = positions.reduce(
    (total, position) => total + (position.marketValueCents ?? 0),
    0
  );
  const totalAccountValueCents = showTotals
    ? investmentTotalCents + (cashBalanceCents ?? 0)
    : 0;

  if (positions.length === 0 && !showTotals) {
    return (
      <div className="bg-surface rounded-lg border border-border shadow-soft px-6 py-8 text-center text-fg-tertiary">
        No positions yet.
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold text-fg">Positions</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-secondary text-fg-secondary">
            <tr>
              <th className="px-6 py-3 text-left font-medium">Security</th>
              <th className="px-6 py-3 text-right font-medium">Shares</th>
              <th className="px-6 py-3 text-right font-medium">Cost Basis</th>
              <th className="px-6 py-3 text-right font-medium">Latest Price</th>
              <th className="px-6 py-3 text-right font-medium">Market Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-secondary">
            {positions.length === 0 ? (
              <tr>
                <td
                  className="px-6 py-6 text-center text-sm text-fg-tertiary"
                  colSpan={5}
                >
                  No positions yet.
                </td>
              </tr>
            ) : (
              positions.map((position) => (
                <tr key={position.securityId}>
                  <td className="px-6 py-4">
                    <div className="font-medium">
                      {bookId ? (
                        <Link
                          href={`/b/${bookId}/securities/${position.securityId}`}
                          className="text-fg-accent hover:underline"
                        >
                          {position.securityName}
                        </Link>
                      ) : (
                        <span className="text-fg">{position.securityName}</span>
                      )}
                    </div>
                    <div className="text-xs text-fg-tertiary">
                      {position.securitySymbol}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {formatShares(position.sharesMicros)}
                  </td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {formatCurrency(position.costBasisCents)}
                  </td>
                  <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                    {formatPrice(position.priceMicros)}
                  </td>
                  <td className="px-6 py-4 text-right text-fg font-medium tabular-nums">
                    {position.marketValueCents === null
                      ? "—"
                      : formatCurrency(position.marketValueCents)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {showTotals && (
            <tfoot className="bg-surface-secondary border-t border-border">
              <tr>
                <td
                  className="px-6 py-3 text-right text-sm font-medium text-fg-secondary"
                  colSpan={4}
                >
                  Investment total
                </td>
                <td className="px-6 py-3 text-right text-sm font-semibold text-fg tabular-nums">
                  {formatCurrency(investmentTotalCents)}
                </td>
              </tr>
              <tr>
                <td
                  className="px-6 py-3 text-right text-sm font-medium text-fg-secondary"
                  colSpan={4}
                >
                  Cash balance
                </td>
                <td className="px-6 py-3 text-right text-sm font-semibold text-fg tabular-nums">
                  {formatCurrency(cashBalanceCents ?? 0)}
                </td>
              </tr>
              <tr>
                <td
                  className="px-6 py-3 text-right text-sm font-semibold text-fg"
                  colSpan={4}
                >
                  Total account value
                </td>
                <td className="px-6 py-3 text-right text-sm font-semibold text-fg tabular-nums">
                  {formatCurrency(totalAccountValueCents)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
