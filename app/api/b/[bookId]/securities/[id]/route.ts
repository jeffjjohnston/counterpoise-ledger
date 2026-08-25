import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { updateSecuritySchema } from "@/lib/schemas/securities";
import {
  SecurityNotFoundError,
  SecurityValidationError,
  deleteSecurity,
  updateSecurity,
} from "@/lib/securities";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    const security = await db.query.securities.findFirst({
      where: and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)),
    });

    if (!security) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }

    return NextResponse.json(security);
  } catch (error) {
    console.error("Error fetching security:", error);
    return NextResponse.json(
      { error: "Failed to fetch security" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);
    // request.json() is awaited unconditionally here, before the id check,
    // to match the original control flow exactly (it parsed the body first
    // too) — reordering would change which error a malformed body plus an
    // invalid id produces.
    const rawBody = await request.json();

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    const parsed = updateSecuritySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      return NextResponse.json(
        await updateSecurity(db, numericBookId, securityId, parsed.data)
      );
    } catch (err) {
      if (err instanceof SecurityNotFoundError) {
        return NextResponse.json({ error: "Security not found" }, { status: 404 });
      }
      if (err instanceof SecurityValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error updating security:", error);
    return NextResponse.json(
      { error: "Failed to update security" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    try {
      await deleteSecurity(db, numericBookId, securityId);
      return NextResponse.json({ success: true });
    } catch (err) {
      if (err instanceof SecurityValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof SecurityNotFoundError) {
        return NextResponse.json({ error: "Security not found" }, { status: 404 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error deleting security:", error);
    return NextResponse.json(
      { error: "Failed to delete security" },
      { status: 500 }
    );
  }
}
