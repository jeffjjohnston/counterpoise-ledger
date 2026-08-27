import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebMcpTools } from "@/components/WebMcpTools";

const { apiGetMock, apiPostMock, useBookIdMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  useBookIdMock: vi.fn(() => "42"),
}));

vi.mock("@/lib/api-client", () => ({
  apiGet: apiGetMock,
  apiPost: apiPostMock,
}));
vi.mock("@/hooks/useBookId", () => ({ useBookId: useBookIdMock }));

type RegisteredTool = {
  name: string;
  annotations?: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

describe("WebMcpTools", () => {
  const registerTool = vi.fn<
    (tool: RegisteredTool, options?: { signal?: AbortSignal }) => Promise<void>
  >(async () => undefined);
  const definitions = [
    {
      name: "list_accounts",
      title: "List Accounts",
      description: "List accounts in the current book",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_transaction",
      title: "Create Transaction",
      description: "Create a transaction in the current book",
      inputSchema: { type: "object", properties: { description: { type: "string" } } },
      annotations: { readOnlyHint: false },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    registerTool.mockImplementation(async () => undefined);
    apiGetMock.mockResolvedValue(definitions);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
  });

  it("registers every tool returned by the existing MCP server", async () => {
    render(<WebMcpTools />);

    await waitFor(() => expect(registerTool).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenCalledWith(
      "/api/b/42/webmcp",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "list_accounts",
      "create_transaction",
    ]);
    expect(registerTool.mock.calls[1][0].annotations?.readOnlyHint).toBe(false);
  });

  it("issues every registration in one task", async () => {
    // The Codex in-app browser rejects a registry that changes more than ten
    // times in one page load. Awaiting each registration in turn makes every
    // tool its own change; issuing them together lets the browser count one.
    let releaseRegistrations = () => {};
    const stillRegistering = new Promise<void>((resolve) => {
      releaseRegistrations = resolve;
    });
    registerTool.mockReturnValue(stillRegistering);

    render(<WebMcpTools />);

    await waitFor(() =>
      expect(registerTool).toHaveBeenCalledTimes(definitions.length)
    );
    releaseRegistrations();
  });

  it("proxies tool execution through the signed-in book endpoint", async () => {
    apiPostMock.mockResolvedValue({ id: 7 });
    render(<WebMcpTools />);
    await waitFor(() => expect(registerTool).toHaveBeenCalledTimes(2));

    await act(async () => {
      await registerTool.mock.calls[1][0].execute({ description: "Coffee" });
    });

    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/b/42/webmcp",
      {
        name: "create_transaction",
        arguments: { description: "Coffee" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("does nothing when the browser does not support WebMCP", () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: undefined,
    });
    expect(() => render(<WebMcpTools />)).not.toThrow();
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
