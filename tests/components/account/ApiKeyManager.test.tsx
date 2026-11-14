import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiKeyManager } from "@/components/account/ApiKeyManager";

const mockKeys = [
  {
    id: 1,
    name: "Claude Desktop",
    keyPrefix: "cpk_abcd",
    lastUsedAt: null,
    createdAt: "2024-01-15T00:00:00.000Z",
  },
  {
    id: 2,
    name: "My Integration",
    keyPrefix: "cpk_efgh",
    lastUsedAt: "2024-02-01T00:00:00.000Z",
    createdAt: "2024-01-20T00:00:00.000Z",
  },
];

describe("ApiKeyManager", () => {
  let originalFetch: typeof global.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // @ts-expect-error - test cleanup
      delete global.fetch;
    }
    vi.restoreAllMocks();
  });

  it("shows loading state then displays fetched API keys", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockKeys,
    });

    render(<ApiKeyManager />);

    expect(screen.getByText("Loading API keys...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    expect(screen.getByText("My Integration")).toBeInTheDocument();
    expect(screen.getByText(/cpk_abcd/)).toBeInTheDocument();
    expect(screen.getByText(/cpk_efgh/)).toBeInTheDocument();
  });

  it("shows last used date when available", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockKeys,
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(screen.getByText("My Integration")).toBeInTheDocument();
    });

    expect(screen.getByText(/Last used/)).toBeInTheDocument();
  });

  it("shows empty state when no keys exist", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(
        screen.getByText("No API keys yet. Create one to use with the MCP server.")
      ).toBeInTheDocument();
    });
  });

  it("shows the server's error message when fetch fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Not authenticated" }),
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(screen.getByText("Not authenticated")).toBeInTheDocument();
    });
  });

  it("falls back to a generic message when fetch fails without a server error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(screen.getByText("Request failed (500)")).toBeInTheDocument();
    });
  });

  it("creates a new key and displays the raw value", async () => {
    // First fetch: load keys (empty)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // POST: create key
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "cpk_newkeyvalue1234567890abcdef" }),
    });
    // Second GET: refresh keys after creation
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 3,
          name: "New Key",
          keyPrefix: "cpk_newk",
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(
        screen.getByText("No API keys yet. Create one to use with the MCP server.")
      ).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g., Claude Desktop");
    fireEvent.change(input, { target: { value: "New Key" } });

    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(
        screen.getByText("Copy your API key now. It will not be shown again.")
      ).toBeInTheDocument();
    });

    expect(screen.getByText("cpk_newkeyvalue1234567890abcdef")).toBeInTheDocument();

    // Verify POST was called with correct payload
    const postCall = fetchMock.mock.calls[1];
    expect(postCall[0]).toBe("/api/auth/api-keys");
    expect(postCall[1]).toMatchObject({ method: "POST" });
    // apiFetch normalizes headers through the Headers constructor (see
    // lib/api-client.ts), not a plain object — toMatchObject can't see into
    // it, since Headers stores entries in an internal slot rather than as
    // own enumerable properties.
    expect((postCall[1].headers as Headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(postCall[1].body as string)).toEqual({ name: "New Key" });
  });

  it("shows error when key name is empty", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(
        screen.getByText("No API keys yet. Create one to use with the MCP server.")
      ).toBeInTheDocument();
    });

    // Submit without entering a name
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(screen.getByText("Key name is required")).toBeInTheDocument();
    });

    // Should not have made a POST request
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows error when create fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Server error creating key" }),
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(
        screen.getByText("No API keys yet. Create one to use with the MCP server.")
      ).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g., Claude Desktop");
    fireEvent.change(input, { target: { value: "My Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(screen.getByText("Server error creating key")).toBeInTheDocument();
    });
  });

  it("deletes a key and removes it from the list", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockKeys,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
    });

    // Verify DELETE was called with correct URL
    const deleteCall = fetchMock.mock.calls[1];
    expect(deleteCall[0]).toBe("/api/auth/api-keys/1");
    expect(deleteCall[1]).toMatchObject({ method: "DELETE" });

    // The second key should still be present
    expect(screen.getByText("My Integration")).toBeInTheDocument();
  });

  it("shows the server's error message when delete fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockKeys,
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Key already revoked" }),
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Key already revoked")).toBeInTheDocument();
    });

    // Key should still be in the list
    expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
  });

  it("copy button is present after key creation", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "cpk_testkey" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    // Mock clipboard
    const clipboardWriteMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteMock },
      writable: true,
      configurable: true,
    });

    render(<ApiKeyManager />);

    await waitFor(() => {
      expect(
        screen.getByText("No API keys yet. Create one to use with the MCP server.")
      ).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g., Claude Desktop");
    fireEvent.change(input, { target: { value: "Test Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(screen.getByText("cpk_testkey")).toBeInTheDocument();
    });

    const copyButton = screen.getByRole("button", { name: "Copy" });
    expect(copyButton).toBeInTheDocument();

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboardWriteMock).toHaveBeenCalledWith("cpk_testkey");
    });
  });
});
