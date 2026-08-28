# Counterpoise for iOS

A basic SwiftUI client for a Counterpoise server. It signs in against an
existing install, lists that user's books, and gives each book a chart of
accounts with balances, a ledger, per-account registers with a running
balance, and a simple two-account transaction entry form.

It is a companion to the web app, not a replacement: investments, recurring
rules, reports, Plaid reconciliation and multi-split entry all stay on the web.

## Requirements

- Xcode 16 or newer (the project uses file-system synchronized groups, so new
  source files are picked up without editing the project file)
- iOS 17.0 or newer
- A running Counterpoise server, reachable from the device

## Opening and running

```bash
open ios/Counterpoise/Counterpoise.xcodeproj
```

Set your own team under Signing & Capabilities (the bundle identifier is
`net.counterpoise.ios`; change it if it collides), then build and run.

On first launch the app asks for a server address and credentials:

- **Server** — `https://books.example.com`, or `http://192.168.1.10:3000` for
  a laptop running `npm run dev`. HTTPS is assumed when no scheme is typed.
  **Test Connection** hits the unauthenticated `/api/health` endpoint, so a
  wrong address is not reported as a wrong password.
- **Username / password** — the same credentials as the web app.

App Transport Security is left on: plain HTTP works only for local-network
addresses (`NSAllowsLocalNetworking` in `Info.plist`), which covers development
against a machine on the same Wi-Fi. Anything reached over the internet must
be served over HTTPS.

## How it authenticates

The API has two credential types. API keys (`cpk_…`) are for MCP and are not
accepted by the HTTP routes, which check a session cookie — so this client logs
in the same way the browser does:

1. `POST /api/auth/login` with the username and password. The server replies
   with `Set-Cookie: counterpoise_session=…`, valid for 30 days.
2. The cookie's value is stored in the keychain
   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and sent as a `Cookie`
   header on every later request.
3. At launch the stored cookie is checked against `GET /api/auth/me`. A 401
   clears it and returns to the sign-in screen; a network failure does not,
   since a server that is merely unreachable would fail sign-in the same way.

The cookie is handled by hand rather than through `HTTPCookieStorage` so it can
live in the keychain, and so the `Secure` attribute the server sets in
production — meaningful to a browser, not to `URLSession` — cannot cause it to
be dropped silently.

## Endpoints used

| Call | Endpoint |
| ---- | -------- |
| Sign in / out / restore | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Connection test | `GET /api/health` |
| Books | `GET /api/books` |
| Accounts with balances | `GET /api/b/{bookId}/accounts` |
| Ledger and registers | `GET /api/b/{bookId}/transactions?includeMeta=true` |
| New transaction | `POST /api/b/{bookId}/transactions` |

## Layout

```
Counterpoise/
  CounterpoiseApp.swift     App entry point
  Models/Models.swift       Wire models, decoded leniently
  Networking/APIClient.swift Async HTTP client and session cookie handling
  Networking/Keychain.swift  Session token storage
  State/AppState.swift      Server, session, and selected book
  Support/Format.swift      Money, dates, account names
  Views/                    SwiftUI screens
```

## Accounting conventions it mirrors

- **Money is always cents**, shares and prices are micros (this client does not
  touch investments). Nothing is parsed into a `Double`.
- **Sign conventions** follow `getNormalBalanceSign()`: assets and expenses are
  debit-normal, liabilities, equity and income credit-normal. `Account`
  balances and register running totals are flipped for display accordingly.
- **Floating transactions** show today's date, the client-side half of
  `effectiveDateSql`.
- **New transactions are two splits that sum to zero**: the *To* account is
  debited, the *From* account credited.

## Known limitations

- Read-only apart from the two-split entry form; editing and deleting are not
  implemented.
- One page of transactions (the 100 most recent) per list, with a footer noting
  how many more exist. No infinite scroll.
- Investment accounts are left out of the entry form's account pickers: a
  split on one is rejected without matching investment splits, which this form
  does not collect. The paired cash sub-account is still selectable.
- Amounts are formatted as USD, matching the ledger, which has no currency
  column.
- No offline cache: every screen loads from the server and pull-to-refresh
  reloads it.
