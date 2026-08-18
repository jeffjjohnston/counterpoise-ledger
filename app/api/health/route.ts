import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * Unauthenticated liveness for the container HEALTHCHECK. Deliberately carries
 * no operational detail: "backups last succeeded 40 days ago" is reconnaissance
 * on an internet-exposed fork. Job status lives behind a session at
 * /api/system/status.
 */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: true });
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
