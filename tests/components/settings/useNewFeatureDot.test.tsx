import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { useNewFeatureDot } from "@/components/settings/useNewFeatureDot";
import { clearDots } from "@/lib/features";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

let state: Record<string, { enabled: boolean; configured: boolean; entrySuggestionsEnabled?: boolean }>;
let gets: string[];

function Probe({ canWrite }: { canWrite: boolean }) {
  const dot = useNewFeatureDot("1", canWrite);
  return <p>{dot ? "dot" : "no dot"}</p>;
}

function renderProbe(canWrite = true) {
  return render(<BookChangesProvider><Probe canWrite={canWrite} /></BookChangesProvider>);
}

describe("useNewFeatureDot", () => {
  beforeEach(() => {
    localStorage.clear();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    state = {
      typesafe: { enabled: true, configured: true },
      "weekly-review": { enabled: false, configured: true },
    };
    gets = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      gets.push(url);
      const id = url.endsWith("/typesafe") ? "typesafe" : url.endsWith("/weekly-review") ? "weekly-review" : null;
      if (id) return { ok: true, json: async () => state[id] } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dot shows for a new, configured, off feature for a writer", async () => {
    renderProbe();
    expect(await screen.findByText("dot")).toBeInTheDocument();
  });

  it("no dot for a viewer", async () => {
    renderProbe(false);
    await act(async () => {});
    expect(screen.getByText("no dot")).toBeInTheDocument();
    expect(gets.filter((url) => url.includes("/settings/"))).toEqual([]);
  });

  it("no dot when not configured", async () => {
    state["weekly-review"] = { enabled: false, configured: false };
    renderProbe();
    await waitFor(() => expect(gets.filter((url) => url.includes("/settings/"))).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("no dot")).toBeInTheDocument();
  });

  it("dot clears on a live books change", async () => {
    renderProbe();
    expect(await screen.findByText("dot")).toBeInTheDocument();
    state["weekly-review"] = { enabled: true, configured: true };
    await act(async () => { FakeWebSocket.instances[0].emit("change", { tables: ["books"] }); });
    expect(await screen.findByText("no dot")).toBeInTheDocument();
  });

  it("dot clears when the settings page clears it", async () => {
    renderProbe();
    expect(await screen.findByText("dot")).toBeInTheDocument();
    await act(async () => { clearDots("1", ["typesafe", "weekly-review"]); });
    expect(screen.getByText("no dot")).toBeInTheDocument();
  });

  const settingsGets = () => gets.filter((url) => url.includes("/settings/"));

  it("sends no request when no feature is new", async () => {
    localStorage.setItem(
      "counterpoise:feature-first-seen",
      JSON.stringify({ typesafe: "2000-01-01", "weekly-review": "2000-01-01" }),
    );
    renderProbe();
    await act(async () => {});
    await act(async () => { FakeWebSocket.instances[0].emit("change", { tables: ["books"] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(settingsGets()).toEqual([]);
    expect(screen.getByText("no dot")).toBeInTheDocument();
  });

  it("reads only the features that can show a dot", async () => {
    clearDots("1", ["typesafe"]);
    renderProbe();
    expect(await screen.findByText("dot")).toBeInTheDocument();
    expect(settingsGets()).toEqual(["/api/b/1/settings/weekly-review"]);
  });

  it("no dot for AI suggestions with only entry suggestions on", async () => {
    state.typesafe = { enabled: false, entrySuggestionsEnabled: true, configured: true };
    state["weekly-review"] = { enabled: true, configured: true };
    renderProbe();
    await waitFor(() => expect(settingsGets()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("no dot")).toBeInTheDocument();
  });

  it("a writer's first sight starts the 60 days; a viewer's does not", async () => {
    const view = renderProbe(false);
    await act(async () => {});
    expect(localStorage.getItem("counterpoise:feature-first-seen")).toBeNull();
    view.unmount();
    renderProbe();
    await act(async () => {});
    expect(Object.keys(JSON.parse(localStorage.getItem("counterpoise:feature-first-seen")!))).toEqual(["typesafe", "weekly-review"]);
  });

  it("dot clears when another tab clears it", async () => {
    renderProbe();
    expect(await screen.findByText("dot")).toBeInTheDocument();
    // The other tab writes storage. This tab gets only the storage event.
    localStorage.setItem("counterpoise:feature-dot-cleared", JSON.stringify(["1:typesafe", "1:weekly-review"]));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "counterpoise:feature-dot-cleared" }));
    });
    expect(screen.getByText("no dot")).toBeInTheDocument();
  });
});
