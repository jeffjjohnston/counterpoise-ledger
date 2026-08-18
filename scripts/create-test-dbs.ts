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

  const dbNames = [
    "counterpoise_dev",
    // Pool IDs range from 1..maxWorkers, but we also create test_0 for safety
    ...Array.from({ length: 9 }, (_, i) => `counterpoise_test_${i}`),
    "counterpoise_e2e",
  ];

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
