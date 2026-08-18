import { PositionsTable } from "@/components/accounts/PositionsTable";
import type { PositionSummary } from "@/lib/investments";

type InvestmentPositionsSectionProps = {
  isVisible: boolean;
  isLoading: boolean;
  positions: PositionSummary[];
  cashBalanceCents?: number;
  bookId?: string;
};

export function InvestmentPositionsSection({
  isVisible,
  isLoading,
  positions,
  cashBalanceCents,
  bookId,
}: InvestmentPositionsSectionProps) {
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="px-6 py-4 border-b border-border bg-surface-secondary"
      data-testid="investment-positions-section"
    >
      {isLoading && positions.length === 0 ? (
        <div
          className="bg-surface rounded-lg border border-border shadow-soft px-6 py-8 animate-pulse"
          data-testid="investment-positions-loading"
        >
          <div className="h-5 w-32 bg-surface-tertiary rounded" />
          <div className="mt-6 space-y-3">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-4 bg-surface-tertiary rounded" />
            ))}
          </div>
        </div>
      ) : (
        <PositionsTable
          positions={positions}
          cashBalanceCents={cashBalanceCents}
          bookId={bookId}
        />
      )}
    </div>
  );
}
