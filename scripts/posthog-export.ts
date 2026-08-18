import { writeFileSync } from "fs";
import {
  escapeHogQLString,
  getPostHogQueryConfig,
  parsePropertiesColumn,
  runHogQLQuery,
} from "../lib/posthog-query";

if (!getPostHogQueryConfig()) {
  console.error("Required env vars: POSTHOG_PERSONAL_API_KEY, NEXT_PUBLIC_POSTHOG_HOST");
  process.exit(1);
}

const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1], 10) : 7;
const outputIndex = args.indexOf("--output");
const outputFile = outputIndex !== -1 ? args[outputIndex + 1] : null;

if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const PAGE_SIZE = 1000;

type ExportedEvent = {
  uuid: string;
  event: string;
  timestamp: string;
  distinctId: string;
  properties: unknown;
};

/** HogQL returns timestamps as ISO strings ("2026-06-05T11:31:14.259000Z"). */
function toHogQLDateTime(isoTimestamp: string): string {
  return isoTimestamp.replace("T", " ").replace("Z", "");
}

async function fetchEvents(lookbackDays: number): Promise<ExportedEvent[]> {
  const allEvents: ExportedEvent[] = [];
  let cursor: { timestamp: string; uuid: string } | null = null;

  for (;;) {
    // OFFSET is not allowed on queries made with a personal API key, so pages
    // advance via a keyset cursor. uuid breaks timestamp ties so events
    // sharing a timestamp at a page boundary are neither skipped nor repeated.
    const cursorFilter = cursor
      ? `AND (timestamp, uuid) > (toDateTime64('${escapeHogQLString(
          toHogQLDateTime(cursor.timestamp)
        )}', 6, 'UTC'), toUUID('${escapeHogQLString(cursor.uuid)}'))`
      : "";
    const { results } = await runHogQLQuery(
      `SELECT uuid, event, timestamp, distinct_id, properties
       FROM events
       WHERE timestamp > now() - INTERVAL ${lookbackDays} DAY
       ${cursorFilter}
       ORDER BY timestamp ASC, uuid ASC
       LIMIT ${PAGE_SIZE}`
    );

    for (const row of results) {
      const [uuid, event, timestamp, distinctId, properties] = row;
      allEvents.push({
        uuid: String(uuid),
        event: String(event),
        timestamp: String(timestamp),
        distinctId: String(distinctId),
        properties: parsePropertiesColumn(properties),
      });
    }

    if (results.length < PAGE_SIZE) break;
    const last = results[results.length - 1];
    cursor = { timestamp: String(last[2]), uuid: String(last[0]) };
  }

  return allEvents.reverse();
}

async function main() {
  console.log(`Fetching PostHog events for the last ${days} days...`);

  const events = await fetchEvents(days);
  console.log(`Fetched ${events.length} events`);

  const output = JSON.stringify(events, null, 2);

  if (outputFile) {
    writeFileSync(outputFile, output);
    console.log(`Written to ${outputFile}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
