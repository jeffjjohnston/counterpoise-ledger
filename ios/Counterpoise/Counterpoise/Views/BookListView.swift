import SwiftUI

struct BookListView: View {
    @EnvironmentObject private var app: AppState

    @State private var books: [Book] = []
    @State private var isLoading = true
    @State private var errorMessage: String? = nil

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    ErrorRow(message: errorMessage)
                }

                ForEach(books) { book in
                    Button {
                        app.open(book)
                    } label: {
                        HStack {
                            Label(book.name, systemImage: "book.closed")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(.primary)
                }

                if books.isEmpty && !isLoading && errorMessage == nil {
                    Text("This account has no books yet. Create one in the web app.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Books")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let user = app.currentUser {
                            Text("Signed in as \(user.username)")
                        }
                        Text(app.serverDisplayName)
                        Divider()
                        Button("Sign Out", role: .destructive) {
                            Task { await app.signOut() }
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .refreshable { await load() }
            .overlay {
                if isLoading && books.isEmpty {
                    ProgressView()
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            books = try await app.api.books()
            app.reopenRememberedBook(from: books)
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }
}
