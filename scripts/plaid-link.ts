/**
 * Mints a Plaid access token for one financial institution.
 *
 * Counterpoise stores an access token per institution and syncs against it,
 * but it does not run Plaid Link itself — the Sync -> Tokens page asks for an
 * access token and an item id that already exist. This script is what
 * produces that pair.
 *
 * It uses Hosted Link, where Plaid serves the Link UI on its own domain, in
 * preference to hosting Link locally. Hosting it locally cannot work for the
 * banks most people want: an OAuth institution (Chase, Wells Fargo, US Bank)
 * requires a `redirect_uri` that is HTTPS in Production and pre-registered in
 * the Plaid dashboard, and `http://localhost` is neither. Hosted Link owns
 * that redirect, so there is no local server, no registration step, and no
 * Link SDK dependency here.
 *
 * The trade is that a Hosted Link session fires no frontend callback, so the
 * public token has to be collected by polling /link/token/get.
 *
 * Usage:
 *   npm run plaid:link     # sandbox, via .env.local
 *
 *   # A real bank, using the deployment's production credentials. Spelled out
 *   # rather than an npm script argument: `npm run plaid:link -- --env-file=X`
 *   # appends the flag after the script path, where node no longer reads it.
 *   npx tsx --env-file=.env.production.local scripts/plaid-link.ts
 *
 *   # Resume a session that outlived the polling window, rather than minting a
 *   # second token and orphaning the first.
 *   npm run plaid:link -- --link-token=link-sandbox-...
 */

import { pathToFileURL } from "url";
import { getPlaidConfig, type PlaidConfig } from "@/lib/plaid";

/** How long to wait for the operator to finish at their bank. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

type PlaidErrorPayload = {
  error_message?: string;
  error_code?: string;
};

/**
 * Pulls the public token out of a /link/token/get response.
 *
 * Exported for tests. Plaid answers 200 with an empty result set while the
 * session is still open, so "no token yet" is the normal in-progress state
 * and never an error. It stays total for the same reason: this runs in a
 * poll loop, and throwing on an unexpected payload would abandon a session
 * the operator may already have completed, stranding the Item.
 */
export function findPublicToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const sessions = (payload as { link_sessions?: unknown }).link_sessions;
  if (!Array.isArray(sessions)) return null;

  // Newest last: re-running against the same link token appends sessions, and
  // the final one is the attempt the operator is watching.
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const results = (sessions[i] as { results?: unknown } | null)?.results;
    if (!results || typeof results !== "object") continue;

    const adds = (results as { item_add_results?: unknown }).item_add_results;
    if (!Array.isArray(adds)) continue;

    // A session can record callbacks that are not item adds, so scan rather
    // than reading adds[0].
    for (const add of adds) {
      const token = (add as { public_token?: unknown } | null)?.public_token;
      if (typeof token === "string" && token.length > 0) return token;
    }
  }

  return null;
}

/**
 * Reads `--link-token=<token>` from argv, or null to mint a fresh one.
 *
 * Exported for tests. An empty value is treated as absent: it means a shell
 * variable did not expand, and polling an empty token would 400 on every tick
 * instead of doing the obvious thing.
 */
export function parseLinkTokenArg(argv: string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith("--link-token="));
  if (!flag) return null;
  const value = flag.slice("--link-token=".length).trim();
  return value.length > 0 ? value : null;
}

async function plaidPost(
  config: PlaidConfig,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      secret: config.secret,
      ...body,
    }),
  });

  if (!response.ok) {
    let payload: PlaidErrorPayload | null = null;
    try {
      payload = (await response.json()) as PlaidErrorPayload;
    } catch {
      payload = null;
    }
    const code = payload?.error_code ? ` (${payload.error_code})` : "";
    const detail = payload?.error_message ? `: ${payload.error_message}` : "";
    throw new Error(`Plaid ${path} failed${detail}${code}`);
  }

  return response.json();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Throws with a named variable when a credential is missing, so an
  // unconfigured run says which one rather than failing at the socket.
  const config = getPlaidConfig();

  // Loud, and before anything is created. Sandbox and Production differ by one
  // word in an env file and by everything else that matters: one connects a
  // fake bank, the other connects the operator's real one and consumes an Item
  // against their plan.
  if (config.env === "production") {
    console.log("\n  *** PLAID_ENV=production — this connects a REAL bank account. ***\n");
  } else {
    console.log("\n  PLAID_ENV=sandbox — test institutions only (user_good / pass_good).\n");
  }

  // Resuming polls the session the operator already opened. Minting a second
  // token instead would leave the first session unwatched: if they went on to
  // finish it at their bank, that Item exists on their Plaid plan — counting
  // against the Trial cap — with a public token nothing will ever exchange.
  const resumeToken = parseLinkTokenArg(process.argv);
  let linkToken = resumeToken;

  if (resumeToken) {
    console.log(`Resuming link token ${resumeToken}.`);
    console.log("Finish at the URL from the earlier run if you have not already.");
  } else {
    const created = (await plaidPost(config, "/link/token/create", {
      client_name: "Counterpoise",
      language: "en",
      country_codes: ["US"],
      products: ["transactions"],
      user: { client_user_id: `counterpoise-${Date.now()}` },
      // Presence of this object is what makes the session Hosted Link and what
      // makes hosted_link_url appear in the response.
      hosted_link: {},
    })) as { link_token?: string; hosted_link_url?: string };

    if (!created.link_token || !created.hosted_link_url) {
      throw new Error(
        "Plaid /link/token/create returned no hosted_link_url. Hosted Link may not be " +
          "enabled for this client id — check the Plaid dashboard."
      );
    }

    linkToken = created.link_token;
    console.log("Open this URL and connect your bank:\n");
    console.log(`  ${created.hosted_link_url}\n`);
  }

  console.log("Waiting for the session to complete (Ctrl-C to abort)...");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let publicToken: string | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const session = await plaidPost(config, "/link/token/get", {
      link_token: linkToken,
    });
    publicToken = findPublicToken(session);
    if (publicToken) break;
  }

  if (!publicToken) {
    // Naming the token is what makes this recoverable. A bare "re-run this
    // script" would mint a new one and stop watching the session the operator
    // may be midway through, or may already have finished.
    throw new Error(
      `Timed out waiting for the Link session. It is still open — resume it with:\n\n` +
        `  npm run plaid:link -- --link-token=${linkToken}\n\n` +
        `Do not re-run without that flag: a fresh token stops watching this ` +
        `session, and an Item you already created would be stranded on your Plaid plan.`
    );
  }

  const exchanged = (await plaidPost(config, "/item/public_token/exchange", {
    public_token: publicToken,
  })) as { access_token?: string; item_id?: string };

  if (!exchanged.access_token || !exchanged.item_id) {
    throw new Error("Plaid /item/public_token/exchange returned an incomplete payload");
  }

  console.log("\nDone. Paste these into Sync -> Tokens in Counterpoise:\n");
  console.log(`  Item ID:      ${exchanged.item_id}`);
  console.log(`  Access Token: ${exchanged.access_token}\n`);
  console.log("The access token does not expire. Treat it like a password:");
  console.log("it reads the connected account's transactions until you revoke it.\n");
}

// Import-safe: the test imports findPublicToken, and must not start a session.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
