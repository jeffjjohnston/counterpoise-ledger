import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

// The check for a new build on the server, with a real memory router. When
// /api/version gives a version that is not the version of this build, the
// banner shows and the next navigation to a different path loads the page
// from the server.

const MARKER = "counterpoise:version-reload-for";

let assign: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;

function serverVersion(version: string) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ version, apiContract: 1 })));
}

beforeEach(() => {
  // A new copy of the module for each test, so that the known server version
  // does not go from one test to the next.
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.0.0");
  assign = vi.fn();
  reload = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost/", assign, reload });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
});

/**
 * A home page, a page that is loaded with the home page, and a page whose
 * chunk loads on demand. The banner is on all of them, as in the root layout.
 */
let releaseLazyChunk: () => void = () => {};

async function start() {
  const { startVersionCheck, checkForNewVersion } = await import("@/client/version-check");
  const { UpdateBanner } = await import("@/client/UpdateBanner");
  const withBanner = (text: string) =>
    function Page() {
      return (
        <>
          <p>{text}</p>
          <UpdateBanner />
        </>
      );
    };
  const router = createMemoryRouter(
    [
      { path: "/", Component: withBanner("Home") },
      { path: "/loaded", Component: withBanner("Loaded") },
      {
        path: "/lazy",
        // The chunk stays pending until the test releases it.
        lazy: async () => {
          await new Promise<void>((resolve) => (releaseLazyChunk = resolve));
          return { Component: withBanner("Lazy") };
        },
      },
    ],
    { initialEntries: ["/"] }
  );
  await act(async () => {
    stop = startVersionCheck(router);
  });
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Home")).toBeInTheDocument();
  return { router, checkForNewVersion };
}

async function go(router: Awaited<ReturnType<typeof start>>["router"], to: string) {
  await act(async () => {
    await router.navigate(to);
  });
}

describe("version check", () => {
  it("does nothing when the server has the same version", async () => {
    serverVersion("1.0.0");
    const { router } = await start();

    expect(fetchMock).toHaveBeenCalledWith("/api/version", { cache: "no-store" });
    expect(screen.queryByText(/new version/)).not.toBeInTheDocument();
    await go(router, "/loaded");
    expect(screen.getByText("Loaded")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the banner, and Reload reloads the page", async () => {
    serverVersion("1.1.0");
    await start();

    expect(screen.getByText(/new version of Counterpoise/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("hides the banner after Later", async () => {
    serverVersion("1.1.0");
    await start();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(/new version/)).not.toBeInTheDocument();
  });

  it("loads a page that is already loaded from the server", async () => {
    serverVersion("1.1.0");
    const { router } = await start();

    await go(router, "/loaded?tab=all");
    expect(assign).toHaveBeenCalledExactlyOnceWith("/loaded?tab=all");
    expect(window.sessionStorage.getItem(MARKER)).toBe("1.1.0");
  });

  it("loads a page whose chunk is not loaded before the router asks for the chunk", async () => {
    serverVersion("1.1.0");
    const { router } = await start();

    let navigation: Promise<void> | undefined;
    await act(async () => {
      navigation = router.navigate("/lazy#top");
    });
    // The chunk is still pending: the old build did not get it.
    expect(assign).toHaveBeenCalledExactlyOnceWith("/lazy#top");
    expect(screen.queryByText("Lazy")).not.toBeInTheDocument();

    await act(async () => {
      releaseLazyChunk();
      await navigation;
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("does not load the page for a change of the query only", async () => {
    serverVersion("1.1.0");
    const { router } = await start();

    await go(router, "/?filter=open");
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not load again for a version that it loaded before in this tab", async () => {
    window.sessionStorage.setItem(MARKER, "1.1.0");
    serverVersion("1.1.0");
    const { router } = await start();

    await go(router, "/loaded");
    expect(assign).not.toHaveBeenCalled();
    // The banner stays, so the user can reload by hand.
    expect(screen.getByText(/new version of Counterpoise/)).toBeInTheDocument();
  });

  it("checks again when the page becomes visible", async () => {
    serverVersion("1.0.0");
    await start();
    expect(screen.queryByText(/new version/)).not.toBeInTheDocument();

    serverVersion("1.1.0");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText(/new version of Counterpoise/)).toBeInTheDocument();
  });

  it("keeps the last known version when a check fails", async () => {
    serverVersion("1.1.0");
    const { checkForNewVersion } = await start();

    fetchMock.mockRejectedValue(new TypeError("Load failed"));
    await act(() => checkForNewVersion());
    fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await act(() => checkForNewVersion());
    expect(screen.getByText(/new version of Counterpoise/)).toBeInTheDocument();
  });
});
