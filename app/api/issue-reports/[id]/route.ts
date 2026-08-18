import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { issueReports } from "@/db/schema";
import { getSession } from "@/lib/session";
import { eq, and } from "drizzle-orm";
import { updateIssueReportSchema } from "@/lib/schemas/issue-reports";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const reportId = Number(id);
    if (isNaN(reportId)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    const parsed = updateIssueReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { description, status, type } = parsed.data;

    const updates: Record<string, unknown> = {};
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (type !== undefined) updates.type = type;

    const db = getDb();
    const [updated] = await db
      .update(issueReports)
      .set(updates)
      .where(
        and(
          eq(issueReports.id, reportId),
          eq(issueReports.userId, session.userId)
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json(
        { error: "Issue report not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating issue report:", error);
    return NextResponse.json(
      { error: "Failed to update issue report" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const reportId = Number(id);
    if (isNaN(reportId)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    const db = getDb();
    const [deleted] = await db
      .delete(issueReports)
      .where(
        and(
          eq(issueReports.id, reportId),
          eq(issueReports.userId, session.userId)
        )
      )
      .returning();

    if (!deleted) {
      return NextResponse.json(
        { error: "Issue report not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting issue report:", error);
    return NextResponse.json(
      { error: "Failed to delete issue report" },
      { status: 500 }
    );
  }
}
