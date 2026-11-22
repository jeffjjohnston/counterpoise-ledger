import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ToastProvider } from "@/components/ui/ToastProvider";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation()
);

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "/api/auth/me") return { ok: true, json: async () => ({ id: 1, username: "alice" }) } as Response;
    return { ok: true, json: async () => [] } as Response;
  }));
}

function renderPage() {
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>,
  );
}

describe("SettingsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("without a book shows Account and This device, and no book group", async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText("Account: applies to all your books")).toBeInTheDocument();
    expect(screen.getByText("This device: stored in this browser")).toBeInTheDocument();
    expect(screen.queryByText(/This book/)).not.toBeInTheDocument();
  });

  it("the side menu links to each section", async () => {
    stubFetch();
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#account", "#security", "#api-keys", "#connected-apps", "#device"]);
    for (const href of hrefs) expect(document.getElementById(href!.slice(1))).not.toBeNull();
  });
});
