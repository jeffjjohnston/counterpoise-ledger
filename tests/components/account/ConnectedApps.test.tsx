import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectedApps } from "@/components/account/ConnectedApps";

const APPS = [
  {
    id: 7,
    clientName: "Claude",
    clientHost: null,
    redirectHost: "claude.ai",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-03T00:00:00.000Z",
  },
  {
    id: 8,
    clientName: "Claude Code",
    clientHost: "claude.ai",
    redirectHost: "localhost",
    createdAt: "2026-10-02T00:00:00.000Z",
    lastUsedAt: null,
  },
];

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("ConnectedApps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists each app with its host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, APPS)));
    render(<ConnectedApps />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(/Returns to claude\.ai/)).toBeInTheDocument();
    expect(screen.getByText(/Published by claude\.ai/)).toBeInTheDocument();
  });

  it("disconnects an app", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? json(200, { success: true }) : json(200, APPS)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectedApps />);
    await screen.findByText("Claude");
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/oauth/grants/7", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("says when no app is connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, [])));
    render(<ConnectedApps />);
    expect(await screen.findByText("No connected apps.")).toBeInTheDocument();
  });
});
