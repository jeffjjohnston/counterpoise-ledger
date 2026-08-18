import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { searchBook } from "@/lib/search";
import { searchQuery } from "@/lib/schemas/search";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const url = new URL(request.url);
    // searchParams.get() returns null for an absent key, not undefined — map
    // null to undefined before parsing, or an absent optional param fails
    // the schema's undefined-only optional check instead of being treated
    // as "not provided". `q` maps with `?? undefined` (the original read was
    // a null check, `?.trim() ?? ""`); the dates map with `|| undefined`
    // (the original read was a truthiness check, `|| undefined`) so an
    // explicit `?startDate=` keeps meaning "absent" instead of reaching the
    // new z.iso.date() check as a real, invalid value. See
    // lib/schemas/search.ts for the full reasoning.
    const parsedQuery = searchQuery.safeParse({
      q: url.searchParams.get("q") ?? undefined,
      startDate: url.searchParams.get("startDate") || undefined,
      endDate: url.searchParams.get("endDate") || undefined,
    });
    if (!parsedQuery.success) {
      return Response.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { q, startDate, endDate } = parsedQuery.data;

    const results = await searchBook(db, numericBookId, q, { startDate, endDate });

    // searchBook returns a superset shared with the MCP tool. Project back to
    // exactly the fields this endpoint has always returned: `notes` on a
    // transaction and `isActive` on an account belong to MCP's contract, not
    // this one, and adding them here would be an unannounced API change.
    return Response.json({
      transactions: results.transactions.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        checkNumber: t.checkNumber,
        payee: t.payee,
        splits: t.splits,
      })),
      accounts: results.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        isFavorite: a.isFavorite,
      })),
      payees: results.payees,
      recurringRules: results.recurringRules,
    });
  } catch (error) {
    console.error("Error searching:", error);
    return Response.json({ error: "Failed to search" }, { status: 500 });
  }
}
