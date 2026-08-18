import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/session";
import { createBookSchema } from "@/lib/schemas/books";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const metaDb = getDb();
    const userBooks = await metaDb
      .select()
      .from(books)
      .where(eq(books.userId, session.userId));

    return NextResponse.json(userBooks);
  } catch (error) {
    console.error("Error fetching books:", error);
    return NextResponse.json(
      { error: "Failed to fetch books" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const parsed = createBookSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { name } = parsed.data;

    const metaDb = getDb();
    const [book] = await metaDb
      .insert(books)
      .values({ userId: session.userId, name })
      .returning();

    return NextResponse.json(book);
  } catch (error) {
    console.error("Error creating book:", error);
    return NextResponse.json(
      { error: "Failed to create book" },
      { status: 500 }
    );
  }
}
