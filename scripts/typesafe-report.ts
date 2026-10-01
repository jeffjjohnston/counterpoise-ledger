// CLI only. It reads the database that DATABASE_PATH names, read-only.
import { existsSync } from "node:fs";
import {
  openReportDatabase,
  reportDatabasePath,
  typeSafeReport,
} from "../lib/typesafe/report";

function main() {
  const [flag, id, ...extra] = process.argv.slice(2);
  if (
    flag !== "--book-id" ||
    !/^[1-9]\d*$/.test(id ?? "") ||
    extra.length ||
    !Number.isSafeInteger(Number(id))
  ) {
    throw new Error("Usage: npm run typesafe:report -- --book-id <id>");
  }
  const path = reportDatabasePath();
  // A read-only open of a missing file fails with an unclear message.
  if (!existsSync(path)) throw new Error(`No database at ${path}; set DATABASE_PATH`);
  const db = openReportDatabase(path);
  try {
    console.log(JSON.stringify(typeSafeReport(db, Number(id)), null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Report failed");
  process.exitCode = 1;
}
