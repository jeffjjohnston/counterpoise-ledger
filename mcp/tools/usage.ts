import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { requireAuth } from "@/mcp/auth";
import {
  escapeHogQLString,
  parsePropertiesColumn,
  runHogQLQuery,
} from "@/lib/posthog-query";

export function registerUsageTools(server: McpServer) {
  server.tool(
    "analyze_usage",
    "Query PostHog for usage analytics — event counts, top pages, session summaries. Use to understand how the app is being used and identify usability issues.",
    {
      days: z.number().min(1).max(90).default(7).describe("Number of days to look back"),
      eventType: z.string().optional().describe("Filter to specific event type (e.g., 'transaction_created', '$pageview')"),
    },
    async ({ days, eventType }) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;

      const lookbackDays = Math.max(1, Math.min(90, Math.floor(days)));
      const after = new Date(Date.now() - lookbackDays * 86400000)
        .toISOString()
        .split("T")[0];

      const eventFilter = eventType
        ? ` AND event = '${escapeHogQLString(eventType)}'`
        : "";
      const where = `timestamp > now() - INTERVAL ${lookbackDays} DAY${eventFilter}`;

      const [countsResult, recentResult] = await Promise.all([
        runHogQLQuery(
          `SELECT event, count() FROM events WHERE ${where} GROUP BY event ORDER BY count() DESC`
        ),
        runHogQLQuery(
          `SELECT event, timestamp, properties FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT 20`
        ),
      ]);

      const eventCounts = countsResult.results.map((row) => ({
        event: String(row[0]),
        count: Number(row[1]),
      }));

      const summary = {
        totalEvents: eventCounts.reduce((sum, entry) => sum + entry.count, 0),
        period: `last ${lookbackDays} days (since ${after})`,
        eventCounts,
        recentEvents: recentResult.results.map((row) => ({
          event: String(row[0]),
          timestamp: String(row[1]),
          properties: parsePropertiesColumn(row[2]),
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
