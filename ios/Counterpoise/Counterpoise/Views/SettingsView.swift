import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    let book: Book

    var body: some View {
        Form {
            Section("Book") {
                LabeledContent("Name", value: book.name)
                Button("Switch Book") { app.closeBook() }
            }

            Section("Account") {
                LabeledContent("Signed in as", value: app.currentUser?.username ?? "—")
                LabeledContent("Server", value: app.serverDisplayName)
            }

            Section {
                Button("Sign Out", role: .destructive) {
                    Task { await app.signOut() }
                }
            } footer: {
                Text("Counterpoise for iOS is a read-mostly companion to the web app: accounts, the ledger, and simple two-account entries.")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}
