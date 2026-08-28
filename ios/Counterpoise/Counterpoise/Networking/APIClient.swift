import Foundation

enum APIError: LocalizedError, Equatable {
    /// No server has been configured yet.
    case notConfigured
    case invalidServerURL(String)
    case unauthorized
    case http(status: Int, message: String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No Counterpoise server has been configured."
        case .invalidServerURL(let text):
            return "\"\(text)\" is not a valid server address."
        case .unauthorized:
            return "Your session has expired. Sign in again."
        case .http(let status, let message):
            return message.isEmpty ? "The server returned status \(status)." : message
        case .transport(let message):
            return message
        case .decoding(let message):
            return "The server sent something unexpected: \(message)"
        }
    }
}

/// Thin async wrapper over the Counterpoise HTTP API.
///
/// Authentication is the same session cookie the web app uses: POST
/// /api/auth/login sets `counterpoise_session`, and every later request sends
/// it back. The cookie is captured by hand rather than left to
/// `HTTPCookieStorage` so it can be persisted in the keychain, and so the
/// `Secure` attribute the server sets in production — meaningful to a browser,
/// not to URLSession — cannot cause it to be silently dropped.
///
/// Main-actor isolated on purpose: the whole client is a handful of small
/// requests driven from SwiftUI, and every `await` here suspends rather than
/// blocks, so a second isolation domain would buy nothing.
@MainActor
final class APIClient {
    static let shared = APIClient()

    static let cookieName = "counterpoise_session"

    /// Root of the Counterpoise install, e.g. https://books.example.com.
    var baseURL: URL?
    /// Value (not the whole header) of the session cookie.
    var sessionToken: String?

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    var isConfigured: Bool { baseURL != nil }
    var hasSession: Bool { sessionToken?.isEmpty == false }

    /// Accepts what someone would actually type — "books.example.com",
    /// "http://192.168.1.10:3000", a stray trailing slash — and returns a URL
    /// the rest of the client can append paths to. Defaults to HTTPS.
    static func normalizedServerURL(from input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw APIError.invalidServerURL(input) }

        let lowered = text.lowercased()
        if !lowered.hasPrefix("http://") && !lowered.hasPrefix("https://") {
            text = "https://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }

        guard let url = URL(string: text), let host = url.host, !host.isEmpty else {
            throw APIError.invalidServerURL(input)
        }
        return url
    }

    // MARK: - Auth

    func logIn(username: String, password: String) async throws -> User {
        let request = try makeRequest(
            "POST",
            "api/auth/login",
            body: LoginRequest(username: username, password: password)
        )
        return try decode(User.self, from: try await perform(request))
    }

    func currentUser() async throws -> User {
        try decode(User.self, from: try await perform(makeRequest("GET", "api/auth/me")))
    }

    func logOut() async throws {
        _ = try await perform(makeRequest("POST", "api/auth/logout"))
        sessionToken = nil
    }

    /// Unauthenticated liveness probe, so "wrong address" and "wrong password"
    /// can be told apart on the sign-in screen.
    func checkHealth() async throws {
        _ = try await perform(makeRequest("GET", "api/health"))
    }

    // MARK: - Books

    func books() async throws -> [Book] {
        try decode([Book].self, from: try await perform(makeRequest("GET", "api/books")))
    }

    // MARK: - Accounts

    /// Root accounts, each with its children nested one level deep — the shape
    /// GET /api/b/{bookId}/accounts returns.
    func accounts(bookId: Int, includeInactive: Bool = false) async throws -> [Account] {
        var query: [URLQueryItem] = []
        if includeInactive {
            query.append(URLQueryItem(name: "includeInactive", value: "true"))
        }
        let request = try makeRequest("GET", "api/b/\(bookId)/accounts", query: query)
        return try decode([Account].self, from: try await perform(request))
    }

    // MARK: - Transactions

    /// Newest first. `accountId` narrows to one account's register, which is
    /// also the only case where `startingBalance` is meaningful.
    func transactions(bookId: Int, accountId: Int? = nil, limit: Int = 100) async throws -> TransactionPage {
        var query = [
            URLQueryItem(name: "includeMeta", value: "true"),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let accountId {
            query.append(URLQueryItem(name: "accountId", value: String(accountId)))
            query.append(URLQueryItem(name: "balanceAccountId", value: String(accountId)))
        }
        let request = try makeRequest("GET", "api/b/\(bookId)/transactions", query: query)
        return try decode(TransactionPage.self, from: try await perform(request))
    }

    /// The response body is the created transaction in a shape this client has
    /// no use for, so it is deliberately discarded — callers reload the list.
    func createTransaction(bookId: Int, transaction: NewTransactionRequest) async throws {
        let request = try makeRequest("POST", "api/b/\(bookId)/transactions", body: transaction)
        _ = try await perform(request)
    }

    // MARK: - Plumbing

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard let baseURL else { throw APIError.notConfigured }

        var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else {
            throw APIError.invalidServerURL(baseURL.absoluteString)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func makeRequest<Body: Encodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Body
    ) throws -> URLRequest {
        var request = try makeRequest(method, path, query: query)
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        var request = request
        if let sessionToken, !sessionToken.isEmpty {
            request.setValue("\(Self.cookieName)=\(sessionToken)", forHTTPHeaderField: "Cookie")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("The server sent a response this app could not read.")
        }
        captureSessionCookie(from: http, requestURL: request.url)

        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.http(
                status: http.statusCode,
                message: Self.serverMessage(from: data)
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        return data
    }

    /// Login is where the session cookie arrives, but any response may rotate
    /// it, so every response is inspected. An empty value — the deletion cookie
    /// logout sends — is ignored; sign-out clears the token explicitly.
    private func captureSessionCookie(from response: HTTPURLResponse, requestURL: URL?) {
        guard let requestURL,
              let fields = response.allHeaderFields as? [String: String] else { return }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: requestURL)
        if let cookie = cookies.first(where: { $0.name == Self.cookieName }), !cookie.value.isEmpty {
            sessionToken = cookie.value
        }
    }

    /// Every Counterpoise route answers failures as `{ "error": "..." }`.
    private static func serverMessage(from data: Data) -> String? {
        struct ErrorBody: Decodable { let error: String }
        guard let body = try? JSONDecoder().decode(ErrorBody.self, from: data),
              !body.error.isEmpty else { return nil }
        return body.error
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}
