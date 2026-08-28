import SwiftUI

/// The whole book's ledger, newest first.
struct TransactionsView: View {
    @EnvironmentObject private var app: AppState
    let book: Book

    @State private var transactions: [LedgerTransaction] = []
    @State private var totalCount = 0
    @State private var isLoading = true
    @State private var errorMessage: String? = nil
    @State private var isAddingTransaction = false

    private let pageSize = 100

    var body: some View {
        List {
            if let errorMessage {
                ErrorRow(message: errorMessage)
            }

            ForEach(transactions) { transaction in
                TransactionRow(transaction: transaction, amount: transaction.totalDebits)
            }

            if transactions.count < totalCount {
                Text("Showing the \(transactions.count) most recent of \(totalCount) transactions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Transactions")
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
            NewTransactionView(book: book) {
                Task { await load() }
            }
        }
        .refreshable { await load() }
        .overlay {
            if isLoading && transactions.isEmpty {
                ProgressView()
            } else if transactions.isEmpty && errorMessage == nil && !isLoading {
                ContentUnavailableView(
                    "No Transactions",
                    systemImage: "tray",
                    description: Text("Transactions you add will appear here.")
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
            let page = try await app.api.transactions(bookId: book.id, limit: pageSize)
            transactions = page.transactions
            totalCount = page.totalCount
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }
}
