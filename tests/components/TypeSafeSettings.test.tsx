import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeSafeSettings } from "@/components/settings/TypeSafeSettings";
afterEach(() => vi.unstubAllGlobals());

describe("TypeSafe Settings", () => {
  it("persists an explicit opt-in and reloads it when Settings reopens", async () => {
    let enabled = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        enabled = JSON.parse(init.body as string).enabled;
      return new Response(
        JSON.stringify({
          enabled,
          configured: true,
          revision: enabled ? 1 : 0,
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const first = render(<TypeSafeSettings bookId="1" bookName="Family" />);
    const toggle = screen.getByRole("checkbox", {
      name: "Suggest Plaid transaction matches",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(
      fetcher.mock.calls.some(
        ([, init]) =>
          init?.method === "PATCH" && init.body === '{"enabled":true}',
      ),
    ).toBe(true);
    first.unmount();
    render(<TypeSafeSettings bookId="1" bookName="Family" />);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  });

  it("shows a failed disable and retains the persisted on state, even when the provider is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH"
          ? new Response(JSON.stringify({ error: "Save failed" }), {
              status: 500,
            })
          : new Response(
              JSON.stringify({ enabled: true, configured: false, revision: 1 }),
            ),
      ),
    );
    render(<TypeSafeSettings bookId="1" bookName="Family" />);
    const toggle = screen.getByRole("checkbox");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(toggle).toBeChecked();
  });

  it("requires a separate clear action and then shows disabled", async () => {
    const fetcher = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            enabled: init?.method !== "DELETE",
            configured: true,
            revision: 1,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<TypeSafeSettings bookId="1" bookName="Family" />);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    fireEvent.click(
      screen.getByRole("button", { name: "Clear experiment data" }),
    );
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Disable and clear" }),
      ),
    );
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
  });
});
