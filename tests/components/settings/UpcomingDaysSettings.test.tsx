import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { UpcomingDaysSaves, UpcomingDaysSettings } from "@/components/settings/UpcomingDaysSettings";
import { ToastProvider } from "@/components/ui/ToastProvider";

describe("UpcomingDaysSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("locks only the book that has a save in flight", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    let finish: () => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(String(init?.body)) as { upcomingDays: number };
      puts.push({ url, body });
      // Book 1's save stays in flight until the test ends it.
      if (url === "/api/books/1") await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, json: async () => ({ id: Number(url.split("/").pop()), name: "B", ...body }) } as Response;
    }));
    const onSaved = vi.fn();
    const saves = new UpcomingDaysSaves();
    const view = (bookId: string, storedValue: number) => (
      <ToastProvider>
        <UpcomingDaysSettings key={bookId} bookId={bookId} storedValue={storedValue} saves={saves} onSaved={onSaved} />
      </ToastProvider>
    );
    const field = () => screen.getByLabelText("Upcoming recurring days");

    const { rerender } = render(view("1", 30));
    fireEvent.change(field(), { target: { value: "14" } });
    await act(async () => { fireEvent.blur(field()); });
    expect(field()).toBeDisabled();

    // The user moves to book 2 while book 1's save is in flight.
    rerender(view("2", 60));
    expect(field()).toBeEnabled();
    expect(field()).toHaveValue(60);
    fireEvent.change(field(), { target: { value: "14" } });
    await act(async () => { fireEvent.blur(field()); });
    await act(async () => { finish(); });

    expect(puts).toEqual([
      { url: "/api/books/1", body: { upcomingDays: 14 } },
      { url: "/api/books/2", body: { upcomingDays: 14 } },
    ]);
    expect(onSaved).toHaveBeenCalledWith({ id: 2, name: "B", upcomingDays: 14 });
    expect(onSaved).toHaveBeenCalledWith({ id: 1, name: "B", upcomingDays: 14 });
  });
});
