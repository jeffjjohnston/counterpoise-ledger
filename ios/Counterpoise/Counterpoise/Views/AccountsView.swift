import SwiftUI

struct AccountsView: View {
    @EnvironmentObject private var app: AppState
    let book: Book

    @State private var roots: [Account] = []
    @State private var includeInactive = false
    @State private var isLoading = true
    @State private var errorMessage: String? = nil

    var body: some View {
        List {
            if let errorMessage {
                ErrorRow(message: errorMessage)
            }

            ForEach(AccountType.allCases, id: \.self) { type in
                let group = roots.filter { $0.type == type }
                if !group.isEmpty {
                    Section {
                        ForEach(group) { account in
                            AccountRow(book: book, account: account, isChild: false)
                            ForEach(account.children) { child in
                                AccountRow(book: book, account: child, isChild: true)
                            }
                        }
                    } header: {
                        HStack {
                            Text(type.displayName)
                            Spacer()
                            Text(Format.currency(cents: total(for: type)))
                                .monospacedDigit()
                        }
                    }
                }
            }
        }
        .navigationTitle(book.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show Inactive Accounts", isOn: $includeInactive)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .refreshable { await load() }
        .overlay {
            if isLoading && roots.isEmpty {
                ProgressView()
            } else if roots.isEmpty && errorMessage == nil && !isLoading {
                ContentUnavailableView("No Accounts", systemImage: "tray", description: Text("This book has no accounts yet."))
            }
        }
        .task(id: includeInactive) { await load() }
    }

    /// A type's total is the sum over every account of that type — parents and
    /// children alike — because the API reports each account's own balance
    /// rather than a rolled-up one.
    private func total(for type: AccountType) -> Int {
        roots
            .filter { $0.type == type }
            .flatMap(\.flattened)
            .reduce(0) { $0 + $1.displayBalance }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            roots = try await app.api.accounts(bookId: book.id, includeInactive: includeInactive)
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }
}

private struct AccountRow: View {
    let book: Book
    let account: Account
    let isChild: Bool

    var body: some View {
        NavigationLink {
            AccountRegisterView(book: book, account: account)
        } label: {
            HStack {
                if let icon = account.icon, !icon.isEmpty {
                    Text(icon)
                }
                Text(Format.shortAccountName(account.name))
                    .foregroundStyle(account.isActive ? Color.primary : Color.secondary)
                Spacer()
                Text(Format.currency(cents: account.displayBalance))
                    .monospacedDigit()
                    .foregroundStyle(account.displayBalance < 0 ? Color.red : Color.primary)
            }
            .padding(.leading, isChild ? 16 : 0)
        }
    }
}
