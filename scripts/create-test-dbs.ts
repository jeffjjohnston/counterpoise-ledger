import postgres from "postgres";

const ADMIN_URL = process.env.DATABASE_URL || "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise";
const DATABASE_ALREADY_EXISTS_CODE = "42P04";

function isDatabaseAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === DATABASE_ALREADY_EXISTS_CODE
  );
}

async function main() {
  const sql = postgres(ADMIN_URL);

  // THE TWO FIXED NAMES, AND VITEST NEEDS NEITHER. Each vitest run mints its
  // own database per worker and creates it as the suite starts, so there is no
  // set of worker databases to pre-create any more — see db/test-db-name.ts.
  // What is left is the local development database and the one Playwright
  // uses, which carries no run dimension.
  const dbNames = ["counterpoise_dev", "counterpoise_e2e"];

  for (const name of dbNames) {
    try {
      await sql.unsafe(`CREATE DATABASE "${name}" OWNER counterpoise`);
      console.log(`  Created ${name}`);
    } catch (e: unknown) {
      if (isDatabaseAlreadyExistsError(e)) {
        // database already exists
        console.log(`  ${name} already exists`);
      } else {
        throw e;
      }
    }
  }

  await sql.end();
  console.log("Test databases ready.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
