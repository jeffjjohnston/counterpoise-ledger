"use client";

import { useEffect } from "react";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost } from "@/lib/api-client";

type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

type ToolDefinition = Omit<WebMcpTool, "execute">;

type ModelContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
};

/** Exposes the existing MCP server's tools through the signed-in web session. */
export function WebMcpTools() {
  const bookId = useBookId();

  useEffect(() => {
    // WebMCP extends Document, as shown by both the specification IDL and the
    // OpenAI site-tools registration example.
    const modelContext = (
      document as Document & { modelContext?: ModelContext }
    ).modelContext;
    if (typeof modelContext?.registerTool !== "function") return;

    const controller = new AbortController();
    const register = async () => {
      const definitions = await apiGet<ToolDefinition[]>(
        `/api/b/${bookId}/webmcp`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      // Register every tool in one turn of the event loop. Awaiting each call
      // in turn puts each registration in its own task, which a browser counts
      // as a separate change to the tool set; the Codex in-app browser allows
      // only ten such changes per page load and rejects the whole registry
      // past that. WebMCP has no bulk-registration call, so a single burst is
      // the only way to present 59 tools as one change.
      await Promise.all(
        definitions.map((definition) =>
          modelContext.registerTool(
            {
              ...definition,
              execute: (input) =>
                apiPost(
                  `/api/b/${bookId}/webmcp`,
                  { name: definition.name, arguments: input },
                  { signal: controller.signal }
                ),
            },
            { signal: controller.signal }
          )
        )
      );
    };

    void register().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn("Unable to register Counterpoise WebMCP tools", error);
      }
    });

    return () => controller.abort();
  }, [bookId]);

  return null;
}
