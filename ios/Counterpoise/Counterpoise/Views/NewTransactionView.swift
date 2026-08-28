import SwiftUI

/// A two-split transaction: money leaves one account and lands in another.
/// That covers a purchase, a deposit, or a transfer, which is as much as a
/// basic client should try to enter — anything with more splits, investments
/// or check handling belongs in the web app.
struct NewTransactionView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss

    let book: Book
    /// Pre-selects the register the sheet was opened from.
    var preferredAccountId: Int? = nil
    let onSaved: () -> Void

    @State private var date = Date()
    @State private var payee = ""
    @State private var note = ""
    @State private var amountText = ""
    @State private var fromAccountId: Int? = nil
    @State private var toAccountId: Int? = nil

    @State private var options: [AccountOption] = []
    @State private var isLoadingAccounts = true
    @State private var isSaving = false
    @State private var errorMessage: String? = nil

    private var cents: Int? {
        guard let value = Format.cents(fromAmount: amountText), value > 0 else { return nil }
        return value
    }

    private var canSave: Bool {
        guard !isSaving, cents != nil,
              let from = fromAccountId, let to = toAccountId else { return false }
        return from != to
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Details") {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    TextField("Payee", text: $payee)
                        .textInputAutocapitalization(.words)
                    TextField("Description", text: $note)
                }

                Section("Amount") {
                    TextField("0.00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }

                Section {
                    picker("From", selection: $fromAccountId)
                    picker("To", selection: $toAccountId)
                } header: {
                    Text("Accounts")
                } footer: {
                    Text("Money is credited to From and debited to To. Paying for groceries with a card: From is the card, To is the expense category.")
                }

                if let errorMessage {
                    Section {
                        ErrorRow(message: errorMessage)
                    }
                }
            }
            .navigationTitle("New Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .overlay {
                if isLoadingAccounts {
                    ProgressView()
                }
            }
            .task { await loadAccounts() }
        }
    }

    private func picker(_ title: String, selection: Binding<Int?>) -> some View {
        Picker(title, selection: selection) {
            Text("Select an account").tag(Int?.none)
            ForEach(AccountType.allCases, id: \.self) { type in
                let group = options.filter { $0.type == type }
                if !group.isEmpty {
                    Section(type.displayName) {
                        ForEach(group) { option in
                            Text(option.label).tag(Int?.some(option.id))
                        }
                    }
                }
            }
        }
    }

    private func loadAccounts() async {
        isLoadingAccounts = true
        defer { isLoadingAccounts = false }

        do {
            let roots = try await app.api.accounts(bookId: book.id)
            options = roots.flatMap { root in
                // A split on an `investment` account is rejected without
                // matching investmentSplits, which this form cannot supply.
                // The brokerage's paired cash sub-account is subtype `cash`
                // and stays selectable, which is the right leg anyway.
                root.flattened.filter { $0.subtype != "investment" }.map { account in
                    AccountOption(
                        id: account.id,
                        label: account.id == root.id
                            ? Format.shortAccountName(account.name)
                            : "\(Format.shortAccountName(root.name)): \(Format.shortAccountName(account.name))",
                        type: account.type
                    )
                }
            }
            applyPreferredAccount()
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }

    /// The account whose register opened this sheet is the one being spent
    /// from when it is an asset or a liability, and the destination otherwise
    /// (an expense category, say).
    private func applyPreferredAccount() {
        guard let preferredAccountId,
              let option = options.first(where: { $0.id == preferredAccountId }) else { return }
        switch option.type {
        case .asset, .liability:
            fromAccountId = option.id
        case .income, .expense, .equity:
            toAccountId = option.id
        }
    }

    private func save() async {
        guard let cents, let from = fromAccountId, let to = toAccountId else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let trimmedPayee = payee.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)

        let request = NewTransactionRequest(
            date: Format.apiDate(from: date),
            description: trimmedNote.isEmpty ? nil : trimmedNote,
            payeeName: trimmedPayee.isEmpty ? nil : trimmedPayee,
            splits: [
                NewSplit(accountId: to, amount: cents),
                NewSplit(accountId: from, amount: -cents),
            ]
        )

        do {
            try await app.api.createTransaction(bookId: book.id, transaction: request)
            onSaved()
            dismiss()
        } catch {
            app.handle(error)
            errorMessage = error.localizedDescription
        }
    }
}

/// A flattened account, labelled "Parent: Child" when it is a sub-account.
private struct AccountOption: Identifiable, Hashable {
    let id: Int
    let label: String
    let type: AccountType
}
