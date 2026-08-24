import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSession } from "@/lib/session";
import { updateIssueReportSchema } from "@/lib/schemas/issue-reports";
import { updateIssueReport, deleteIssueReport, IssueReportNotFoundError } from "@/lib/issue-reports";

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

    try {
      const updated = await updateIssueReport(getDb(), session.userId, reportId, parsed.data);
      return NextResponse.json(updated);
    } catch (error) {
      if (error instanceof IssueReportNotFoundError) {
        return NextResponse.json(
          { error: "Issue report not found" },
          { status: 404 }
        );
      }
      throw error;
    }
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

    try {
      await deleteIssueReport(getDb(), session.userId, reportId);
      return NextResponse.json({ success: true });
    } catch (error) {
      if (error instanceof IssueReportNotFoundError) {
        return NextResponse.json(
          { error: "Issue report not found" },
          { status: 404 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Error deleting issue report:", error);
    return NextResponse.json(
      { error: "Failed to delete issue report" },
      { status: 500 }
    );
  }
}
