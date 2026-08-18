import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { issueReports } from "@/db/schema";
import { getSession } from "@/lib/session";
import { captureEvent } from "@/lib/posthog-server";
import { createIssueReportSchema } from "@/lib/schemas/issue-reports";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const db = getDb();
    const reports = await db
      .select()
      .from(issueReports)
      .where(eq(issueReports.userId, session.userId))
      .orderBy(desc(issueReports.createdAt));

    return NextResponse.json(reports);
  } catch (error) {
    console.error("Error fetching issue reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch issue reports" },
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

    const parsed = createIssueReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { description, type, page } = parsed.data;

    const db = getDb();
    const [report] = await db
      .insert(issueReports)
      .values({
        userId: session.userId,
        description,
        type,
        page,
      })
      .returning();

    captureEvent(session.userId, "issue_report_created", {
      type,
      page,
    });

    return NextResponse.json(report);
  } catch (error) {
    console.error("Error creating issue report:", error);
    return NextResponse.json(
      { error: "Failed to create issue report" },
      { status: 500 }
    );
  }
}
