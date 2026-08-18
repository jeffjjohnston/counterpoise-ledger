import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateApiKey, hashApiKey, getKeyPrefix } from "@/lib/api-keys";
import { createApiKeySchema } from "@/lib/schemas/auth";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const db = getDb();
    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, session.userId))
      .orderBy(desc(apiKeys.createdAt));

    return NextResponse.json(keys);
  } catch (error) {
    console.error("Error fetching API keys:", error);
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const parsed = createApiKeySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { name } = parsed.data;

    const key = generateApiKey();
    const keyHash = await hashApiKey(key);
    const keyPrefix = getKeyPrefix(key);

    const db = getDb();
    const [created] = await db
      .insert(apiKeys)
      .values({
        userId: session.userId,
        name,
        keyHash,
        keyPrefix,
      })
      .returning();

    return NextResponse.json({
      id: created.id,
      name: created.name,
      key, // Plaintext key — shown ONCE
      keyPrefix,
      createdAt: created.createdAt,
    });
  } catch (error) {
    console.error("Error creating API key:", error);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
