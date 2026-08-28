import Foundation

/// Display and parsing helpers, mirroring lib/formatters.ts on the server.
/// Money is always cents, dates are always "YYYY-MM-DD" strings.
enum Format {
    // MARK: - Money

    private static let currencyFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        // Counterpoise books are kept in USD; the ledger has no currency
        // column, so the locale must not be allowed to reinterpret the number.
        formatter.currencyCode = "USD"
        return formatter
    }()

    static func currency(cents: Int) -> String {
        let amount = NSDecimalNumber(value: cents).dividing(by: NSDecimalNumber(value: 100))
        return currencyFormatter.string(from: amount) ?? "\(Double(cents) / 100)"
    }

    /// Parses what a person types into an amount field. Accepts a leading
    /// currency symbol, thousands separators, and a comma as the decimal
    /// separator when no period is present (as most of Europe writes it).
    static func cents(fromAmount text: String) -> Int? {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.contains(",") && !cleaned.contains(".") {
            cleaned = cleaned.replacingOccurrences(of: ",", with: ".")
        }
        cleaned = String(cleaned.filter { $0.isNumber || $0 == "." || $0 == "-" })
        guard !cleaned.isEmpty, cleaned != "-", cleaned != ".",
              let value = Decimal(string: cleaned) else { return nil }

        var scaled = value * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .plain)
        return NSDecimalNumber(decimal: rounded).intValue
    }

    // MARK: - Dates

    /// Fixed-format parser for the API's "YYYY-MM-DD" strings. `en_US_POSIX`
    /// keeps it immune to the device's calendar and 12/24-hour setting.
    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let shortDisplayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()

    static func apiDate(from date: Date) -> String { isoFormatter.string(from: date) }

    static func date(fromAPI text: String) -> Date? { isoFormatter.date(from: text) }

    static var todayString: String { apiDate(from: Date()) }

    /// "Aug 28, 2026". Falls back to the raw string if it will not parse.
    static func displayDate(_ apiDate: String) -> String {
        guard let date = date(fromAPI: apiDate) else { return apiDate }
        return displayFormatter.string(from: date)
    }

    /// "Aug 28" — for dense register rows, where the year is usually noise.
    static func shortDate(_ apiDate: String) -> String {
        guard let date = date(fromAPI: apiDate) else { return apiDate }
        return shortDisplayFormatter.string(from: date)
    }

    // MARK: - Names

    /// Account names arrive as full paths ("Expenses:Auto:Fuel"); the leaf is
    /// what a row has room for. Mirrors getAccountShortName().
    static func shortAccountName(_ name: String) -> String {
        name.split(separator: ":").last.map(String.init) ?? name
    }
}
