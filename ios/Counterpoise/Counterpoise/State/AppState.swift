import Combine
import Foundation

/// Everything the app knows between launches: which server, whose session,
/// and which book is open. Views read the API through `api`.
@MainActor
final class AppState: ObservableObject {
    private enum Keys {
        static let serverURL = "serverURL"
        static let sessionToken = "sessionToken"
        static let selectedBookId = "selectedBookId"
    }

    @Published private(set) var serverURL: URL? = nil
    @Published private(set) var currentUser: User? = nil
    @Published private(set) var isRestoring = true
    @Published var selectedBook: Book? = nil

    let api: APIClient
    private let defaults: UserDefaults

    init(api: APIClient = .shared, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults

        if let stored = defaults.string(forKey: Keys.serverURL), let url = URL(string: stored) {
            serverURL = url
            api.baseURL = url
        }
        api.sessionToken = Keychain.string(forKey: Keys.sessionToken)
    }

    var serverDisplayName: String { serverURL?.absoluteString ?? "Not configured" }

    /// Called once at launch: a stored cookie is only worth trusting if the
    /// server still recognises it, so it is checked rather than assumed.
    func restoreSession() async {
        defer { isRestoring = false }
        guard api.isConfigured, api.hasSession else { return }

        do {
            currentUser = try await api.currentUser()
        } catch APIError.unauthorized {
            clearSession()
        } catch {
            // A server that is merely unreachable right now must not throw the
            // session away — the sign-in screen would just fail the same way.
            currentUser = nil
        }
    }

    func signIn(server: String, username: String, password: String) async throws {
        let url = try APIClient.normalizedServerURL(from: server)
        api.baseURL = url

        let user: User
        do {
            user = try await api.logIn(username: username, password: password)
        } catch {
            // Leave the previously working server configured if this one failed.
            api.baseURL = serverURL
            throw error
        }

        serverURL = url
        defaults.set(url.absoluteString, forKey: Keys.serverURL)
        Keychain.set(api.sessionToken, forKey: Keys.sessionToken)
        currentUser = user
    }

    func signOut() async {
        try? await api.logOut()
        clearSession()
    }

    func open(_ book: Book) {
        selectedBook = book
        defaults.set(book.id, forKey: Keys.selectedBookId)
    }

    func closeBook() {
        selectedBook = nil
        defaults.removeObject(forKey: Keys.selectedBookId)
    }

    /// Signs out when the server says the session is gone, so a stale cookie
    /// surfaces as the sign-in screen rather than an error on every tab.
    func handle(_ error: Error) {
        guard let apiError = error as? APIError, apiError == .unauthorized else { return }
        clearSession()
    }

    private func clearSession() {
        api.sessionToken = nil
        Keychain.remove(key: Keys.sessionToken)
        currentUser = nil
        selectedBook = nil
    }

    /// Re-opens the book the user last had open. Only its id is stored, so the
    /// book list calls this once it has real `Book` values to match against.
    func reopenRememberedBook(from books: [Book]) {
        guard selectedBook == nil,
              defaults.object(forKey: Keys.selectedBookId) != nil else { return }
        let rememberedId = defaults.integer(forKey: Keys.selectedBookId)
        if let book = books.first(where: { $0.id == rememberedId }) {
            selectedBook = book
        }
    }
}
