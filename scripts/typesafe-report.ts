// CLI only. Routes import lib/typesafe/report, never this entrypoint.
import { closeDb, getDb } from "../db";
import { typeSafeReport } from "../lib/typesafe/report";

async function main() {
  const [flag, id, ...extra] = process.argv.slice(2);
  if (
    flag !== "--book-id" ||
    !/^[1-9]\d*$/.test(id ?? "") ||
    extra.length ||
    !Number.isSafeInteger(Number(id))
  ) {
    throw new Error("Usage: npm run typesafe:report -- --book-id <id>");
  }
  console.log(
    JSON.stringify(await typeSafeReport(getDb(), Number(id)), null, 2),
  );
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Report failed");
    process.exitCode = 1;
  })
  .finally(closeDb);
