import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WeeklyReviewSettings } from "@/components/settings/WeeklyReviewSettings";
import { WEEKLY_REVIEW_SETTINGS_EVENT } from "@/lib/weekly-review";

type Call = { url: string; init?: RequestInit };

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body, headers: new Headers() } as Response;
  }));
  return calls;
}

describe("WeeklyReviewSettings", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("turns the review on with a PATCH", async () => {
    const calls = mockFetch([
      { body: { enabled: false, revision: 0, configured: true } },
      { body: { enabled: true, revision: 1, configured: true } },
    ]);
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe("/api/b/1/settings/weekly-review");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ enabled: true });
  });

  it("says what goes to Anthropic", async () => {
    mockFetch([{ body: { enabled: false, revision: 0, configured: true } }]);
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    expect(await screen.findByText(/memos and account names/i)).toBeInTheDocument();
  });

  it("is disabled when the server has no key", async () => {
    mockFetch([{ body: { enabled: false, revision: 0, configured: false } }]);
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    expect(await screen.findByText(/not available on this installation/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /weekly review/i })).toBeDisabled();
  });

  it("turns off and deletes the reviews after a confirmation", async () => {
    const calls = mockFetch([
      { body: { enabled: true, revision: 1, configured: true } },
      { body: { enabled: false, revision: 2, configured: true } },
    ]);
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    fireEvent.click(await screen.findByRole("button", { name: /turn off and delete reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete reviews$/i }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
  });
  it("keeps the saved state when a focus during the save could read the old state", async () => {
    let releasePatch: (value: unknown) => void = () => {};
    let serverEnabled = false;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;
      if (init?.method === "PATCH") {
        return new Promise((resolve) => {
          releasePatch = () => { serverEnabled = true; resolve(answer({ enabled: true, revision: 1, configured: true })); };
        });
      }
      // A read sees the server state when it starts, and answers late.
      const snapshot = { enabled: serverEnabled, revision: serverEnabled ? 1 : 0, configured: true };
      return new Promise((resolve) => setTimeout(() => resolve(answer(snapshot)), 50));
    }));
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { releasePatch(null); });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(toggle).toBeChecked();
  });

  it("tells the dashboard card after a save", async () => {
    mockFetch([
      { body: { enabled: false, revision: 0, configured: true } },
      { body: { enabled: true, revision: 1, configured: true } },
    ]);
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<{ bookId: string }>).detail.bookId);
    window.addEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, listener);
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(heard).toEqual(["1"]));
    window.removeEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, listener);
  });
  it("loads again after a save when the window got the focus during it", async () => {
    let releasePatch: (value: unknown) => void = () => {};
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;
      if (init?.method === "PATCH") {
        return new Promise((resolve) => { releasePatch = () => resolve(answer({ enabled: true, revision: 1, configured: true })); });
      }
      gets += 1;
      // After the save, another editor turned it off again (revision 2).
      return Promise.resolve(answer(gets === 1 ? { enabled: false, revision: 0, configured: true } : { enabled: false, revision: 2, configured: true }));
    }));
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { releasePatch(null); });
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(gets).toBe(2);
  });
  it("keeps a save error when the reload after the save succeeds", async () => {
    let rejectPatch: () => void = () => {};
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise((resolve) => {
          rejectPatch = () => resolve({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }), headers: new Headers() } as Response);
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ enabled: false, revision: 0, configured: true }), headers: new Headers() } as Response);
    }));
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { rejectPatch(); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("alert")).toHaveTextContent("Forbidden");
  });
  it("a successful save clears an earlier read error", async () => {
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
      if (init?.method === "PATCH") return Promise.resolve(answer(200, { enabled: true, revision: 1, configured: true }));
      gets += 1;
      return Promise.resolve(gets === 1 ? answer(200, { enabled: false, revision: 0, configured: true }) : answer(500, { error: "boom" }));
    }));
    render(<WeeklyReviewSettings bookId="1" bookName="Family" />);
    const toggle = await screen.findByRole("checkbox", { name: /weekly review/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
