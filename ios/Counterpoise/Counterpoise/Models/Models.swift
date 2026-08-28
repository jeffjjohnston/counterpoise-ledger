import Foundation

// Wire models for the Counterpoise HTTP API. Every type decodes leniently:
// the same JSON shapes are served by several routes with slightly different
// projections (an account nested inside a split carries no `balance`, the
// search route omits `notes`), and a missing key must not fail the whole page.

struct User: Decodable, Identifiable, Hashable {
    let id: Int
    let username: String
}

struct Book: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let upcomingDays: Int?
}

/// Mirrors the `type` enum on `accounts` in db/schema.ts.
enum AccountType: String, Decodable, CaseIterable, Hashable {
    case asset
    case liability
    case equity
    case income
    case expense

    var displayName: String {
        switch self {
        case .asset: return "Assets"
        case .liability: return "Liabilities"
        case .equity: return "Equity"
        case .income: return "Income"
        case .expense: return "Expenses"
        }
    }

    /// Mirrors getNormalBalanceSign() in lib/accounting.ts: assets and
    /// expenses are debit-normal, everything else credit-normal.
    var normalBalanceSign: Int {
        switch self {
        case .asset, .expense: return 1
        case .liability, .equity, .income: return -1
        }
    }
}

struct Account: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let type: AccountType
    let subtype: String?
    let parentId: Int?
    let isActive: Bool
    let isFavorite: Bool
    let isInvestmentCash: Bool
    let icon: String?
    /// Raw signed balance in cents, as stored (debits positive).
    let balance: Int
    let hasTransactions: Bool
    let children: [Account]

    /// Balance flipped into the sign the account type reads naturally in,
    /// the way getDisplayBalance() does on the web.
    var displayBalance: Int { balance * type.normalBalanceSign }

    /// Self, then descendants, depth first.
    var flattened: [Account] { [self] + children.flatMap(\.flattened) }

    enum CodingKeys: String, CodingKey {
        case id, name, type, subtype, parentId, isActive, isFavorite
        case isInvestmentCash, icon, balance, hasTransactions, children
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        type = try container.decodeIfPresent(AccountType.self, forKey: .type) ?? .asset
        subtype = try container.decodeIfPresent(String.self, forKey: .subtype)
        parentId = try container.decodeIfPresent(Int.self, forKey: .parentId)
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? true
        isFavorite = try container.decodeIfPresent(Bool.self, forKey: .isFavorite) ?? false
        isInvestmentCash = try container.decodeIfPresent(Bool.self, forKey: .isInvestmentCash) ?? false
        icon = try container.decodeIfPresent(String.self, forKey: .icon)
        balance = try container.decodeIfPresent(Int.self, forKey: .balance) ?? 0
        hasTransactions = try container.decodeIfPresent(Bool.self, forKey: .hasTransactions) ?? false
        children = try container.decodeIfPresent([Account].self, forKey: .children) ?? []
    }
}

struct Payee: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
}

struct TransactionSplit: Decodable, Identifiable, Hashable {
    let id: Int
    let accountId: Int
    /// Cents. Positive is a debit, negative a credit; splits sum to zero.
    let amount: Int
    let account: Account?
}

/// Named `LedgerTransaction` rather than `Transaction` so it cannot be
/// confused with SwiftUI's own `Transaction` type.
struct LedgerTransaction: Decodable, Identifiable, Hashable {
    let id: Int
    let date: String
    let descriptionText: String?
    let checkNumber: String?
    let notes: String?
    let isReconciled: Bool
    let isFloating: Bool
    let payee: Payee?
    let splits: [TransactionSplit]

    enum CodingKeys: String, CodingKey {
        case id, date
        case descriptionText = "description"
        case checkNumber, notes, isReconciled, isFloating, payee, splits
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        date = try container.decode(String.self, forKey: .date)
        descriptionText = try container.decodeIfPresent(String.self, forKey: .descriptionText)
        checkNumber = try container.decodeIfPresent(String.self, forKey: .checkNumber)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        isReconciled = try container.decodeIfPresent(Bool.self, forKey: .isReconciled) ?? false
        isFloating = try container.decodeIfPresent(Bool.self, forKey: .isFloating) ?? false
        payee = try container.decodeIfPresent(Payee.self, forKey: .payee)
        splits = try container.decodeIfPresent([TransactionSplit].self, forKey: .splits) ?? []
    }

    /// A floating transaction's effective date advances to today until it is
    /// reconciled — the client-side half of effectiveDateSql.
    var effectiveDate: String { isFloating ? Format.todayString : date }

    var title: String {
        if let name = payee?.name, !name.isEmpty { return name }
        if let text = descriptionText, !text.isEmpty { return text }
        return "(no payee)"
    }

    /// Subtitle: the description when a payee already took the title slot,
    /// otherwise the accounts this transaction touches.
    func subtitle(excludingAccountId excluded: Int? = nil) -> String {
        if payee != nil, let text = descriptionText, !text.isEmpty { return text }
        var names: [String] = []
        for split in splits where split.accountId != excluded {
            guard let name = split.account.map({ Format.shortAccountName($0.name) }) else { continue }
            if !names.contains(name) { names.append(name) }
        }
        return names.joined(separator: " · ")
    }

    /// Net effect on one account, in cents.
    func amount(forAccount accountId: Int) -> Int {
        splits.filter { $0.accountId == accountId }.reduce(0) { $0 + $1.amount }
    }

    /// The size of the transaction: total debits, which equal total credits.
    var totalDebits: Int {
        splits.filter { $0.amount > 0 }.reduce(0) { $0 + $1.amount }
    }
}

/// The `includeMeta=true` envelope from GET /api/b/{bookId}/transactions.
struct TransactionPage: Decodable {
    let transactions: [LedgerTransaction]
    let startingBalance: Int
    let totalCount: Int

    enum CodingKeys: String, CodingKey {
        case transactions, startingBalance, totalCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transactions = try container.decodeIfPresent([LedgerTransaction].self, forKey: .transactions) ?? []
        startingBalance = try container.decodeIfPresent(Int.self, forKey: .startingBalance) ?? 0
        totalCount = try container.decodeIfPresent(Int.self, forKey: .totalCount) ?? 0
    }

    static let empty = TransactionPage(transactions: [], startingBalance: 0, totalCount: 0)

    private init(transactions: [LedgerTransaction], startingBalance: Int, totalCount: Int) {
        self.transactions = transactions
        self.startingBalance = startingBalance
        self.totalCount = totalCount
    }
}

// MARK: - Request bodies

struct LoginRequest: Encodable {
    let username: String
    let password: String
}

struct NewSplit: Encodable {
    let accountId: Int
    /// Cents. Positive debits the account, negative credits it.
    let amount: Int
}

struct NewTransactionRequest: Encodable {
    let date: String
    let description: String?
    let payeeName: String?
    let splits: [NewSplit]
}
