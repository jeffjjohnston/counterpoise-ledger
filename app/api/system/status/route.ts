import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { evaluateJobHealth } from "@/lib/job-health";
import { readJobEntries, JobStatusUnreadableError } from "@/lib/job-status-store";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const entries = await readJobEntries();
    return NextResponse.json(evaluateJobHealth(entries, new Date()));
  } catch (error) {
    if (error instanceof JobStatusUnreadableError) {
      // Surface it rather than degrading to "unknown", which the indicator
      // hides: a broken monitoring path is itself something to act on.
      return NextResponse.json({
        ...evaluateJobHealth(null, new Date()),
        overall: "attention" as const,
        error: error.message,
      });
    }
    throw error;
  }
}
