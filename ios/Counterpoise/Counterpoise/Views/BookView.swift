import SwiftUI

/// The open book: accounts, the ledger, and settings. Each tab carries its own
/// navigation stack, which is why a book replaces the root instead of being
/// pushed onto the book list's stack.
struct BookView: View {
    let book: Book

    var body: some View {
        TabView {
            NavigationStack {
                AccountsView(book: book)
            }
            .tabItem { Label("Accounts", systemImage: "list.bullet.rectangle") }

            NavigationStack {
                TransactionsView(book: book)
            }
            .tabItem { Label("Transactions", systemImage: "arrow.left.arrow.right") }

            NavigationStack {
                SettingsView(book: book)
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
