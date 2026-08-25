import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { captureEvent } from "@/lib/posthog-server";
import { reconcileListQuery, reconcileSchema } from "@/lib/schemas/sync";
import {
  getReconcilableLink,
  listReconciliationQueue,
  RECONCILE_EVENT_NAMES,
  ReconcileNotFoundError,
  ReconcileValidationError,
  resolveReconciliation,
} from "@/lib/plaid-reconcile";

function parseLinkId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const linkId = parseLinkId(id);
    if (linkId === null) {
      return NextResponse.json({ error: "Invalid linked account id" }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    // reconcileListQuery's limit/offset fields never fail (see
    // lib/schemas/sync.ts) — safeParse here can't return success: false,
    // but it's still safeParse + the standard guard for consistency with
    // every other query wiring in this codebase (same convention
    // securities.ts's price/split routes use for their own .catch()-backed
    // limit/offset).
    const parsedQuery = reconcileListQuery.safeParse({
      limit: searchParams.get("limit") || undefined,
      offset: searchParams.get("offset") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { limit, offset } = parsedQuery.data;

    const link = await getReconcilableLink(db, numericBookId, linkId);
    const page = await listReconciliationQueue(db, numericBookId, link, { limit, offset });

    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof ReconcileNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ReconcileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error loading sync reconciliation queue:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load reconciliation queue" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const linkId = parseLinkId(id);
    if (linkId === null) {
      return NextResponse.json({ error: "Invalid linked account id" }, { status: 400 });
    }

    const link = await getReconcilableLink(db, numericBookId, linkId);

    const parsed = reconcileSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const item = await resolveReconciliation(db, numericBookId, link, parsed.data);

    captureEvent(auth.userId, RECONCILE_EVENT_NAMES[parsed.data.action], {
      bookId: numericBookId,
    });

    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof ReconcileNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ReconcileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error resolving sync reconciliation action:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve reconciliation" },
      { status: 500 }
    );
  }
}
