import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PLAID_LINK_POLL_MS, PlaidLinkModal } from "@/components/sync/PlaidLinkModal";
import type { PlaidLinkSession } from "@/types";

function session(overrides: Partial<PlaidLinkSession>): PlaidLinkSession {
  return {
    id: 7, mode: "create", status: "pending", tokenId: null, financialInstitution: null,
    hostedLinkUrl: "https://hosted.plaid.test/link/7", expiresAt: "2026-10-09T14:00:00.000Z", error: null,
    ...overrides,
  };
}

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** Lets the pending fetches and the state updates run. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("PlaidLinkModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a session, polls while it is pending, and reports completion one time", async () => {
    const checks: PlaidLinkSession[] = [
      session({}),
      session({ status: "complete", tokenId: 9, financialInstitution: "First Platypus Bank", hostedLinkUrl: null }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/b/1/sync/link-sessions") return reply(session({}));
      if (url === "/api/b/1/sync/link-sessions/7/check") return reply(checks.shift() ?? session({ status: "complete", tokenId: 9 }));
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onComplete = vi.fn();
    const onMapAccounts = vi.fn();

    render(
      <PlaidLinkModal bookId="1" tokenId={null} onClose={vi.fn()} onComplete={onComplete} onMapAccounts={onMapAccounts} />
    );
    await flush();
    expect(screen.getByRole("link", { name: "Open Plaid" })).toHaveAttribute("href", "https://hosted.plaid.test/link/7");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await flush(PLAID_LINK_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();

    await flush(PLAID_LINK_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/First Platypus Bank is connected/)).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: "complete", tokenId: 9 });

    // A complete session is not polled again.
    await flush(PLAID_LINK_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Map accounts" }));
    expect(onMapAccounts).toHaveBeenCalledWith(9);
  });

  it("stops polling on a failed check until the user asks again", async () => {
    let fail = true;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url === "/api/b/1/sync/link-sessions") return reply(session({ mode: "update", tokenId: 5, financialInstitution: "Chase" }));
      if (fail) return reply({ error: "Plaid /link/token/get request failed" }, 502);
      return reply(session({ mode: "update", tokenId: 5, status: "complete", financialInstitution: "Chase", hostedLinkUrl: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlaidLinkModal bookId="1" tokenId={5} institution="Chase" onClose={vi.fn()} onComplete={vi.fn()} />);
    await flush();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ tokenId: 5 });
    await flush(PLAID_LINK_POLL_MS);
    expect(screen.getByText("Plaid /link/token/get request failed")).toBeInTheDocument();
    await flush(PLAID_LINK_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await flush(PLAID_LINK_POLL_MS);
    expect(screen.getByText("Chase is reconnected. The next sync uses it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("continues the open session on mount, and asks for a new one on Start again", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/b/1/sync/link-sessions") {
        bodies.push(JSON.parse(String(init?.body)));
        return reply(session({ id: bodies.length }));
      }
      return reply(session({ id: 1, status: "expired", hostedLinkUrl: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlaidLinkModal bookId="1" tokenId={null} onClose={vi.fn()} onComplete={vi.fn()} />);
    await flush();
    expect(bodies).toEqual([{ tokenId: null }]);
    await flush(PLAID_LINK_POLL_MS);
    expect(screen.getByText(/This session expired/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Plaid" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await flush();
    expect(bodies).toEqual([{ tokenId: null }, { tokenId: null, restart: true }]);
    expect(screen.getByRole("link", { name: "Open Plaid" })).toBeInTheDocument();
  });

  it("asks for a new session on Start again after a failed check", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/b/1/sync/link-sessions") {
        bodies.push(JSON.parse(String(init?.body)));
        return reply(session({ id: bodies.length }));
      }
      // The public token of session 1 is spent: each check fails again.
      return reply({ error: "Plaid /item/public_token/exchange request failed" }, 502);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlaidLinkModal bookId="1" tokenId={null} onClose={vi.fn()} onComplete={vi.fn()} />);
    await flush();
    await flush(PLAID_LINK_POLL_MS);
    expect(screen.getByText("Plaid /item/public_token/exchange request failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await flush();
    expect(bodies).toEqual([{ tokenId: null }, { tokenId: null, restart: true }]);
    expect(screen.queryByText("Plaid /item/public_token/exchange request failed")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Plaid" })).toBeInTheDocument();
  });

  it("asks for a new session on Try again after a failed start", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return reply({ error: "Plaid /link/token/create request failed" }, 502);
      return reply(session({ mode: "update", tokenId: 5 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlaidLinkModal bookId="1" tokenId={5} institution="Chase" onClose={vi.fn()} onComplete={vi.fn()} />);
    await flush();
    expect(screen.getByText("Plaid /link/token/create request failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(bodies).toEqual([{ tokenId: 5 }, { tokenId: 5, restart: true }]);
    expect(screen.getByRole("link", { name: "Open Plaid" })).toBeInTheDocument();
  });

  it("offers Try again after a network failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return reply(session({}));
    }));

    render(<PlaidLinkModal bookId="1" tokenId={null} onClose={vi.fn()} onComplete={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByRole("link", { name: "Open Plaid" })).toBeInTheDocument();
  });

  it("does not offer Try again after a 4xx start error, which fails again on each try", async () => {
    const fetchMock = vi.fn(async () => reply({ error: "A demo connection cannot be reconnected" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    render(<PlaidLinkModal bookId="1" tokenId={5} institution="Demo Bank" onClose={onClose} onComplete={vi.fn()} />);
    await flush();
    expect(screen.getByText("A demo connection cannot be reconnected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
