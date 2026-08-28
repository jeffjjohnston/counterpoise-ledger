import SwiftUI

/// One account's register, with a running balance. The API returns rows newest
/// first plus the balance of everything older than the last row on the page,
/// so the running total is accumulated from the bottom up and then flipped
/// back for display.
struct AccountRegisterView: View {
    @EnvironmentObject private var app: AppState
    let book: Book
    let account: Account

    @State private var page = TransactionPage.empty
    @State private var isLoading = true
    @State private var errorMessage: String? = nil
    @State private var isAddingTransaction = false

    private var rows: [RegisterRow] {
        var running = page.startingBalance
        var oldestFirst: [RegisterRow] = []
        for transaction in page.transactions.reversed() {
            running += transaction.amount(forAccount: account.id)
            oldestFirst.append(RegisterRow(transaction: transaction, balance: running))
        }
        return Array(oldestFirst.reversed())
    }

    var body: some View {
        List {
            if let errorMessage {
                ErrorRow(message: errorMessage)
            }

            ForEach(rows) { row in
                TransactionRow(
                    transaction: row.transaction,
                    amount: row.transaction.amount(forAccount: account.id),
                    excludingAccountId: account.id,
                    runningBalance: row.balance * account.type.normalBalanceSign
                )
            }

            if page.transactions.count < page.totalCount {
                Text("Showing the \(page.transactions.count) most recent of \(page.totalCount) transactions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(Format.shortAccountName(account.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    isAddingTransaction = true
                } label: {
                    Label("New Transaction", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $isAddingTransaction) {
            NewTransactionView(book: book, preferredAccountId: account.id) {
                Task { await load() }
            }
        }
        .refreshable { await load() }
        .overlay {
            if isLoading && page.transactions.isEmpty {
                ProgressView()
            } else if page.transactions.isEmpty && errorMessage == nil && !isLoading {
                ContentUnavailableView(
                    "No Transactions",
                    systemImage: "tray",
                    description: Text("Nothing has been posted to this account.")
                )
            }
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            page = try await app.api.transactions(bookId: book.id, accountId: account.id)
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }
}

/// One ledger line plus the account balance as of that line.
private struct RegisterRow: Identifiable {
    let transaction: LedgerTransaction
    let balance: Int
    var id: Int { transaction.id }
}
