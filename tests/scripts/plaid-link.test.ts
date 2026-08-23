import { describe, expect, it } from "vitest";
import { findPublicToken, parseLinkTokenArg } from "@/scripts/plaid-link";

/**
 * `/link/token/get` is the only way a Hosted Link session hands back its
 * public token — there is no frontend callback to receive one. The response
 * nests it three levels down and reports an in-progress session with the same
 * 200 as a finished one, so the walk below is what the poll loop tests to
 * decide whether the user has finished at their bank yet.
 */
const session = (results: unknown) => ({
  link_sessions: [{ link_session_id: "session-1", results }],
});

describe("findPublicToken", () => {
  it("returns the public token from a completed session", () => {
    expect(
      findPublicToken(
        session({ item_add_results: [{ public_token: "public-sandbox-abc" }] })
      )
    ).toBe("public-sandbox-abc");
  });

  it("returns null while the session is still open", () => {
    // Plaid answers 200 with an empty result set until the user finishes at
    // their bank. Treating that as an error would abort a session the user is
    // midway through; it is the poll loop's "keep waiting" signal.
    expect(findPublicToken(session({ item_add_results: [] }))).toBeNull();
    expect(findPublicToken(session({}))).toBeNull();
    expect(findPublicToken({ link_sessions: [] })).toBeNull();
  });

  it("skips result entries that carry no public token", () => {
    // A session can record callbacks that are not item adds. Reading
    // results[0] blindly would return undefined and strand a token that did
    // arrive in a later entry.
    expect(
      findPublicToken(
        session({
          item_add_results: [
            { institution: { name: "Platypus Bank" } },
            { public_token: "public-sandbox-xyz" },
          ],
        })
      )
    ).toBe("public-sandbox-xyz");
  });

  it("reads the newest session when Plaid returns several", () => {
    // Re-running the script against the same link token appends sessions.
    // The last one is the attempt the operator is watching.
    expect(
      findPublicToken({
        link_sessions: [
          { results: { item_add_results: [{ public_token: "stale" }] } },
          { results: { item_add_results: [{ public_token: "current" }] } },
        ],
      })
    ).toBe("current");
  });

  it("tolerates malformed payloads rather than throwing", () => {
    // This runs inside a poll loop. A throw here kills a session the operator
    // may already have completed at their bank, losing the Item.
    for (const payload of [null, undefined, {}, "", 7, { link_sessions: null }]) {
      expect(findPublicToken(payload)).toBeNull();
    }
  });
});

describe("parseLinkTokenArg", () => {
  // A Link session outlives this script's polling window, so a timeout must be
  // resumable. Without it the operator's only option is a fresh token, which
  // orphans any Item they already created at their bank — it stays on their
  // Plaid plan, counting against the Trial cap, with a public token nobody
  // will ever exchange.
  it("reads the link token to resume", () => {
    expect(
      parseLinkTokenArg(["node", "plaid-link.ts", "--link-token=link-sandbox-abc"])
    ).toBe("link-sandbox-abc");
  });

  it("returns null when resuming was not asked for", () => {
    expect(parseLinkTokenArg(["node", "plaid-link.ts"])).toBeNull();
  });

  it("treats an empty value as absent rather than resuming nothing", () => {
    // `--link-token=` with a shell variable that did not expand. Polling an
    // empty token would 400 on every tick; minting a fresh one is right.
    expect(parseLinkTokenArg(["node", "plaid-link.ts", "--link-token="])).toBeNull();
  });

  it("ignores unrelated arguments", () => {
    expect(
      parseLinkTokenArg(["node", "plaid-link.ts", "--verbose", "--link-token=tok", "extra"])
    ).toBe("tok");
  });
});
