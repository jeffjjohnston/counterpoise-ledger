import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { updateSecurityPriceSchema } from "@/lib/schemas/security-prices";
import {
  updateSecurityPrice,
  deleteSecurityPrice,
  PriceEntryNotFoundError,
  PriceEntryConflictError,
} from "@/lib/security-prices";
import { SecurityNotFoundError } from "@/lib/securities";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string; date: string }> }
) {
  try {
    const { bookId, id, date } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    const parsed = updateSecurityPriceSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      await updateSecurityPrice(db, numericBookId, securityId, date, parsed.data);
      return NextResponse.json({ success: true });
    } catch (err) {
      if (err instanceof SecurityNotFoundError) {
        return NextResponse.json({ error: "Security not found" }, { status: 404 });
      }
      if (err instanceof PriceEntryNotFoundError) {
        return NextResponse.json({ error: "Price entry not found" }, { status: 404 });
      }
      if (err instanceof PriceEntryConflictError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error updating security price:", error);
    return NextResponse.json({ error: "Failed to update security price" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string; date: string }> }
) {
  try {
    const { bookId, id, date } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    try {
      await deleteSecurityPrice(db, numericBookId, securityId, date);
      return NextResponse.json({ success: true });
    } catch (err) {
      if (err instanceof SecurityNotFoundError) {
        return NextResponse.json({ error: "Security not found" }, { status: 404 });
      }
      if (err instanceof PriceEntryNotFoundError) {
        return NextResponse.json({ error: "Price entry not found" }, { status: 404 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error deleting security price:", error);
    return NextResponse.json({ error: "Failed to delete security price" }, { status: 500 });
  }
}
