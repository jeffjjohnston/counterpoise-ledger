import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { runWithMcpAuth } from "@/mcp/auth";
import { callWebMcpTool, listWebMcpTools } from "@/mcp/webmcp";

type RouteContext = { params: Promise<{ bookId: string }> };

async function authenticate(context: RouteContext) {
  const { bookId } = await context.params;
  return authenticateBookRequest(bookId);
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await authenticate(context);
  if (isError(auth)) return auth.error;
  return Response.json(await listWebMcpTools());
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticate(context);
  if (isError(auth)) return auth.error;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "A JSON request body is required" }, { status: 400 });
  }
  const { name, arguments: args } = body as {
    name?: unknown;
    arguments?: unknown;
  };
  if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
    return Response.json({ error: "name and arguments are required" }, { status: 400 });
  }

  try {
    const result = await runWithMcpAuth(
      { userId: auth.userId, keyId: 0 },
      () => callWebMcpTool(name, args as Record<string, unknown>, auth.bookId)
    );
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
