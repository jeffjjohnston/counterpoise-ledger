import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";

// The root error page of the client, with a real memory router. A route that
// cannot load its chunk must reload the page one time only. Other errors show
// a message with a Reload button and a link to the books page.

const MARKER = "counterpoise:stale-chunk-reload-at";

// The error that Chromium gives when a hashed chunk is gone after a deploy.
const chunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://example.test/assets/page-0ld0ld.js"
  );

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A new copy of the module for each test, so that its "reload started" flag
  // does not go from one test to the next.
  vi.resetModules();
  reload = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost/", reload });
  window.sessionStorage.clear();
  // React and the error page write the caught error to the console.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

/**
 * A home page and a page at /target whose chunk fails to load (or whose
 * component throws). The router starts at the home page and then goes to
 * /target, as a click on a link does.
 */
async function navigateToFailingPage(target: Pick<RouteObject, "lazy" | "Component">) {
  const { RouteError } = await import("@/client/RouteError");
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: () => <p>Home</p>,
        ErrorBoundary: RouteError,
      },
      { path: "/target", ErrorBoundary: RouteError, ...target },
    ],
    { initialEntries: ["/"] }
  );
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Home")).toBeInTheDocument();
  await act(async () => {
    await router.navigate("/target");
  });
  return router;
}

const failingChunk = { lazy: () => Promise.reject(chunkError()) };

describe("isChunkLoadError", () => {
  it("knows the error of each browser for a missing chunk", async () => {
    const { isChunkLoadError } = await import("@/client/stale-chunk");
    for (const message of [
      "Failed to fetch dynamically imported module: https://x.test/assets/a-1.js", // Chromium
      "error loading dynamically imported module: https://x.test/assets/a-1.js", // Firefox
      "Importing a module script failed.", // Safari
      "Unable to preload CSS for /assets/a-1.css", // Vite, for a missing CSS chunk
      "'text/html' is not a valid JavaScript MIME type.", // Safari, HTML for a script
    ]) {
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
    }
  });

  it("does not take other errors for a missing chunk", async () => {
    const { isChunkLoadError } = await import("@/client/stale-chunk");
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new Error("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("the route table", () => {
  it("gives the root route the error page, so that each page error gets to it", async () => {
    // The module makes the browser router, which reads the real location.
    vi.unstubAllGlobals();
    const [{ routes }, { RouteError }] = await Promise.all([
      import("@/client/routes"),
      import("@/client/RouteError"),
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0].ErrorBoundary).toBe(RouteError);
  });
});

describe("RouteError", () => {
  it("reloads the page one time when a chunk does not load", async () => {
    const router = await navigateToFailingPage(failingChunk);

    expect(reload).toHaveBeenCalledTimes(1);
    // The router is at the page that failed, so the reload loads that page
    // and not the page before it.
    expect(router.state.location.pathname).toBe("/target");
    expect(screen.getByRole("status")).toHaveTextContent("Loading the new version");
    expect(Number(window.sessionStorage.getItem(MARKER))).toBeGreaterThan(0);
  });

  it("does not reload again when the chunk fails soon after a reload", async () => {
    // The page reloaded 5 seconds ago for the same reason.
    window.sessionStorage.setItem(MARKER, String(Date.now() - 5_000));

    await navigateToFailingPage(failingChunk);

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "This page did not load" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again when the last reload is not recent", async () => {
    window.sessionStorage.setItem(MARKER, String(Date.now() - 10 * 60_000));

    await navigateToFailingPage(failingChunk);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when it cannot keep the marker", async () => {
    // Without the marker, a reload that does not fix the error can start a
    // loop. The page shows the error and lets the user reload.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    await navigateToFailingPage(failingChunk);

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "This page did not load" })).toBeInTheDocument();
  });

  it("shows a message, a Reload button and a link to the books for other errors", async () => {
    await navigateToFailingPage({
      Component: () => {
        throw new Error("The register has no rows");
      },
    });

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText("The register has no rows")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your books" })).toHaveAttribute("href", "/");

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
