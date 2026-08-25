import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  createSecurity,
  listSecurities,
  SecurityValidationError,
  SecurityDuplicateError,
} from "@/lib/securities";
import { createSecuritySchema } from "@/lib/schemas/securities";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    return NextResponse.json(await listSecurities(db, numericBookId));
  } catch (error) {
    console.error("Error fetching securities:", error);
    return NextResponse.json(
      { error: "Failed to fetch securities" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createSecuritySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      const created = await createSecurity(db, numericBookId, parsed.data);
      return NextResponse.json(created);
    } catch (err) {
      if (err instanceof SecurityValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof SecurityDuplicateError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error creating security:", error);
    return NextResponse.json(
      { error: "Failed to create security" },
      { status: 500 }
    );
  }
}
