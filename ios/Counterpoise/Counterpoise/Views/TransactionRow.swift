import SwiftUI

struct TransactionRow: View {
    let transaction: LedgerTransaction
    /// Cents, in whatever sense the caller cares about: the account's own
    /// movement in a register, the transaction's size in the book-wide list.
    let amount: Int
    var excludingAccountId: Int? = nil
    var runningBalance: Int? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(transaction.title)
                    .lineLimit(1)
                let subtitle = transaction.subtitle(excludingAccountId: excludingAccountId)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    Text(Format.shortDate(transaction.effectiveDate))
                    if transaction.isFloating {
                        Label("Floating", systemImage: "clock")
                            .labelStyle(.iconOnly)
                    }
                    if transaction.isReconciled {
                        Label("Reconciled", systemImage: "checkmark.circle")
                            .labelStyle(.iconOnly)
                    }
                    if let checkNumber = transaction.checkNumber, !checkNumber.isEmpty {
                        Text("#\(checkNumber)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.currency(cents: amount))
                    .monospacedDigit()
                    .foregroundStyle(amount < 0 ? Color.red : Color.primary)
                if let runningBalance {
                    Text(Format.currency(cents: runningBalance))
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
