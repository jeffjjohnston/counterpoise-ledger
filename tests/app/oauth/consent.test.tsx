import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConsentForm, type ConsentDetails } from "@/app/oauth/consent/ConsentForm";

const QUERY = "response_type=code&client_id=cpc_1&state=s";

const DETAILS: ConsentDetails = {
  client: { name: "Claude", clientId: "cpc_1", metadataDocument: false, host: null },
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  redirectHost: "claude.ai",
  loopbackOnly: false,
  username: "alice",
  server: "https://books.example.com",
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Answers the details call with `details` and the decision with `decision`. */
function stubFetch(details: () => Response, decision: () => Response = () => json(200, { redirectTo: "https://claude.ai/cb?code=x" })) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST" ? decision() : details()
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ConsentForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("names the app, the user and the host that the browser returns to", async () => {
    const fetchMock = stubFetch(() => json(200, DETAILS));
    render(<ConsentForm query={QUERY} leave={vi.fn()} />);
    await screen.findByTestId("consent-ready");
    expect(fetchMock).toHaveBeenCalledWith(`/api/oauth/consent?${QUERY}`, expect.anything());
    expect(screen.getByRole("heading", { name: "Connect Claude to Counterpoise?" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as alice")).toBeInTheDocument();
    expect(screen.getByText("claude.ai")).toBeInTheDocument();
    expect(screen.getByText(/cannot verify its name/)).toBeInTheDocument();
    expect(screen.queryByText(/program on your computer/)).toBeNull();
  });

  it("shows the publisher of a metadata document, and warns about a loopback-only app", async () => {
    stubFetch(() =>
      json(200, {
        ...DETAILS,
        client: { ...DETAILS.client, metadataDocument: true, host: "claude.ai" },
        redirectHost: "localhost",
        loopbackOnly: true,
      })
    );
    render(<ConsentForm query={QUERY} leave={vi.fn()} />);
    await screen.findByTestId("consent-ready");
    expect(screen.getByText("Published by claude.ai")).toBeInTheDocument();
    expect(screen.getByText(/program on your computer \(localhost\)/)).toBeInTheDocument();
  });

  it("sends the approval with the query, then leaves for the redirect URI", async () => {
    const fetchMock = stubFetch(() => json(200, DETAILS));
    const leave = vi.fn();
    render(<ConsentForm query={QUERY} leave={leave} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith("https://claude.ai/cb?code=x"));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toEqual({ query: QUERY, approve: true });
  });

  it("sends a denial", async () => {
    const fetchMock = stubFetch(() => json(200, DETAILS));
    const leave = vi.fn();
    render(<ConsentForm query={QUERY} leave={leave} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(leave).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ approve: false });
  });

  // A request that the client must get back at its redirect URI is not sent
  // there without a click. Every client registers itself, so the redirect
  // URI proves nothing about the destination: an automatic redirect would be
  // an open redirect from this origin (RFC 9700 section 4.11.2).
  it("shows a refused request, and returns to the app only when the user asks", async () => {
    stubFetch(() =>
      json(200, {
        error: "The app sent a request that this server cannot accept: PKCE is required",
        returnTo: "https://evil.example/cb?error=invalid_request",
        returnHost: "evil.example",
      })
    );
    const leave = vi.fn();
    render(<ConsentForm query={QUERY} leave={leave} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("PKCE is required");
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Return to evil.example" }));
    expect(leave).toHaveBeenCalledWith("https://evil.example/cb?error=invalid_request");
  });

  it("shows a decision that the server refused instead of leaving", async () => {
    stubFetch(
      () => json(200, DETAILS),
      () => json(200, { error: "The app sent a request that this server cannot accept", returnTo: "https://claude.ai/cb?error=invalid_request", returnHost: "claude.ai" })
    );
    const leave = vi.fn();
    render(<ConsentForm query={QUERY} leave={leave} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot accept");
    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Return to claude.ai" })).toBeInTheDocument();
  });

  it("shows the error of a request that cannot go back to the app", async () => {
    stubFetch(() => json(400, { error: "The redirect_uri is not one that the client registered" }));
    const leave = vi.fn();
    render(<ConsentForm query={QUERY} leave={leave} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The redirect_uri is not one that the client registered");
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
