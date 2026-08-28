import SwiftUI

/// Three states, in order: restoring a stored session, signed out, signed in.
/// A book is opened by replacing the root rather than pushing, so each book
/// tab owns its own navigation stack.
struct RootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Group {
            if app.isRestoring {
                ProgressView("Connecting…")
            } else if app.currentUser == nil {
                LoginView()
            } else if let book = app.selectedBook {
                BookView(book: book)
            } else {
                BookListView()
            }
        }
        .animation(.default, value: app.currentUser)
        .animation(.default, value: app.selectedBook)
        .task { await app.restoreSession() }
    }
}
