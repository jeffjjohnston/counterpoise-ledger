import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var app: AppState

    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorMessage: String? = nil
    @State private var statusMessage: String? = nil

    private var canSubmit: Bool {
        !isBusy
            && !server.trimmingCharacters(in: .whitespaces).isEmpty
            && !username.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("counterpoise.example.com", text: $server)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("The address of your Counterpoise install. HTTPS is assumed unless you type http://.")
                }

                Section("Sign in") {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { if canSubmit { Task { await signIn() } } }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                if let statusMessage {
                    Section {
                        Label(statusMessage, systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                    }
                }

                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Text("Sign In")
                            if isBusy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!canSubmit)

                    Button("Test Connection") {
                        Task { await testConnection() }
                    }
                    .disabled(isBusy || server.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle("Counterpoise")
        }
        .onAppear {
            if server.isEmpty, let existing = app.serverURL {
                server = existing.absoluteString
            }
        }
    }

    private func signIn() async {
        isBusy = true
        errorMessage = nil
        statusMessage = nil
        defer { isBusy = false }

        do {
            try await app.signIn(server: server, username: username, password: password)
            password = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Hits the unauthenticated health endpoint, so a typo in the address is
    /// not reported as a bad password.
    private func testConnection() async {
        isBusy = true
        errorMessage = nil
        statusMessage = nil
        defer { isBusy = false }

        do {
            let url = try APIClient.normalizedServerURL(from: server)
            let previous = app.api.baseURL
            app.api.baseURL = url
            defer { app.api.baseURL = previous }
            try await app.api.checkHealth()
            statusMessage = "Reached \(url.absoluteString)."
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
