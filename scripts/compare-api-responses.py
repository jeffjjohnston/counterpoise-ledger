#!/usr/bin/env python3
"""Capture the GET responses of every book of a running server, and compare two captures.

usage: compare-api-responses.py capture BASE_URL OUT_DIR USER PASSWORD
       compare-api-responses.py diff DIR_A DIR_B [--rebuilt-lots PATH]...

scripts/verify-postgres-conversion.sh uses it to compare the PostgreSQL server
with the SQLite server on the converted copy of the same database. The diff
exits 1 when a response differs. A response whose only difference is the
order of a list of objects with IDs is reported as ORDER and does not fail,
because a query without ORDER BY can return rows in a different order on each
engine.

--rebuilt-lots PATH names the lots response of a security whose lots the
converter rebuilt (a pair with a floating transaction). The rebuild gives
those lots new IDs, and the route orders lots of one date by ID. So that
response is compared without its "lotId" values and in a fixed order. Every
other value must still be equal.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def request(base, path, cookie=None, body=None):
    headers = {"origin": base}
    if cookie:
        headers["cookie"] = cookie
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def capture(base, out, user, password):
    os.makedirs(out, exist_ok=True)
    status, body, headers = request(base, "/api/auth/login", body={"username": user, "password": password})
    assert status == 200, (status, body)
    cookie = headers["set-cookie"].split(";")[0]
    saved = 0

    def get(path):
        nonlocal saved
        status, body, _ = request(base, path, cookie)
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = body.decode(errors="replace")
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", path.strip("/"))[:200]
        with open(os.path.join(out, name + ".json"), "w") as f:
            json.dump({"path": path, "status": status, "body": parsed}, f, indent=1, sort_keys=False, ensure_ascii=False)
        saved += 1
        return status, parsed

    for path in ["/api/version", "/api/books", "/api/auth/me", "/api/auth/api-keys", "/api/auth/registration-open", "/api/issue-reports"]:
        get(path)
    _, books = get("/api/books")
    for book in books:
        b = book["id"]
        p = f"/api/b/{b}"
        get(f"/api/books/{b}/members")
        for path in ["/accounts", "/settings/typesafe", "/sync/pending-count", "/sync/tokens", "/sync/reconcile",
                     "/sync/assigned-accounts", "/sync/pending-transactions", "/sync/stale-unmatched", "/payees",
                     "/payees?search=a", "/payees?search=gro&limit=5", "/investments/positions",
                     "/investments/account-values", "/investments/account-values?asOf=2024-06-30", "/securities",
                     "/securities/prices-due", "/transactions", "/transactions?limit=100&offset=0",
                     "/transactions?limit=100&offset=500", "/transactions?startDate=2024-01-01&endDate=2024-03-31",
                     "/recurring", "/recurring/projected?startDate=2025-01-01&endDate=2025-12-31",
                     "/recurring/transactions?startDate=2024-01-01&endDate=2025-12-31",
                     "/reports/data?startDate=2024-01-01&endDate=2024-12-31",
                     "/reports/income-statement?startDate=2024-01-01&endDate=2024-12-31",
                     "/reports/realized-gains", "/reports/realized-gains?year=2024",
                     "/search?q=a", "/search?q=coffee", "/search?q=100.00"]:
            get(p + path)
        _, accounts = get(p + "/accounts")
        for account in accounts if isinstance(accounts, list) else []:
            get(f"{p}/accounts/{account['id']}")
            get(f"{p}/transactions?accountId={account['id']}&limit=200")
        _, payees = get(p + "/payees")
        for payee in (payees if isinstance(payees, list) else [])[:60]:
            get(f"{p}/payees/{payee['id']}")
            get(f"{p}/payees/{payee['id']}/last-account")
        _, securities = get(p + "/securities")
        for security in securities if isinstance(securities, list) else []:
            for suffix in ["", "/detail", "/lots", "/splits", "/splits?limit=10&offset=5", "/prices"]:
                get(f"{p}/securities/{security['id']}{suffix}")
        _, recurring = get(p + "/recurring")
        rules = recurring if isinstance(recurring, list) else recurring.get("rules", []) if isinstance(recurring, dict) else []
        for rule in rules:
            if isinstance(rule, dict) and "id" in rule:
                get(f"{p}/recurring/{rule['id']}")
        _, page = get(p + "/transactions?limit=150")
        items = page if isinstance(page, list) else page.get("transactions", []) if isinstance(page, dict) else []
        for txn in items:
            get(f"{p}/transactions/{txn['id']}")
            get(f"{p}/transactions/{txn['id']}/plaid")
        _, tokens = get(p + "/sync/tokens")
        for token in tokens if isinstance(tokens, list) else []:
            get(f"{p}/sync/tokens/{token['id']}/accounts")
    print(f"saved {saved} responses into {out}")


def by_id(value):
    """The value with each list of objects with IDs sorted by ID."""
    if isinstance(value, dict):
        return {k: by_id(v) for k, v in value.items()}
    if isinstance(value, list):
        items = [by_id(v) for v in value]
        if items and all(isinstance(v, dict) and "id" in v for v in items):
            items.sort(key=lambda v: v["id"])
        return items
    return value


def without_lot_ids(response):
    """The response with the "lotId" key removed from each object of its body,
    and the objects in a fixed order."""
    body = response["body"]
    if isinstance(body, list):
        body = [{k: v for k, v in item.items() if k != "lotId"} if isinstance(item, dict) else item for item in body]
        body.sort(key=lambda item: json.dumps(item, sort_keys=True))
    return {**response, "body": body}


def diff(a, b, rebuilt_lots=()):
    order_only = 0
    names = sorted(set(os.listdir(a)) | set(os.listdir(b)))
    different = 0
    for name in names:
        pa, pb = os.path.join(a, name), os.path.join(b, name)
        if not (os.path.exists(pa) and os.path.exists(pb)):
            print("MISSING", name)
            different += 1
            continue
        ja, jb = json.load(open(pa)), json.load(open(pb))
        if ja["path"] in rebuilt_lots:
            ja, jb = without_lot_ids(ja), without_lot_ids(jb)
        if ja != jb and by_id(ja) == by_id(jb):
            order_only += 1
            print("ORDER", ja["path"])
            continue
        if ja != jb:
            different += 1
            print("DIFF", ja["path"], ja["status"], jb["status"])
            sa, sb = json.dumps(ja["body"], sort_keys=True), json.dumps(jb["body"], sort_keys=True)
            for i, (x, y) in enumerate(zip(sa, sb)):
                if x != y:
                    print("   A:", sa[max(0, i - 150):i + 150])
                    print("   B:", sb[max(0, i - 150):i + 150])
                    break
            else:
                print("   lengths", len(sa), len(sb))
    print(f"{len(names)} responses, {different} differ, {order_only} differ in row order only")
    return different


if __name__ == "__main__":
    if sys.argv[1] == "capture":
        capture(*sys.argv[2:6])
    else:
        options = sys.argv[4:]
        rebuilt = [options[i + 1] for i in range(0, len(options) - 1, 2) if options[i] == "--rebuilt-lots"]
        if len(options) != 2 * len(rebuilt):
            sys.exit("usage: compare-api-responses.py diff DIR_A DIR_B [--rebuilt-lots PATH]...")
        sys.exit(1 if diff(sys.argv[2], sys.argv[3], rebuilt) else 0)
