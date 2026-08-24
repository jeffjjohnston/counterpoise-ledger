import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSession } from "@/lib/session";
import { captureEvent } from "@/lib/posthog-server";
import { createIssueReportSchema } from "@/lib/schemas/issue-reports";
import { createIssueReport, listIssueReports } from "@/lib/issue-reports";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const reports = await listIssueReports(getDb(), session.userId);

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
    const { type, page } = parsed.data;

    const report = await createIssueReport(getDb(), session.userId, parsed.data);

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
