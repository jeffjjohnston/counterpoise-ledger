import { runMigrations, closeDb } from "./index";

async function main() {
  console.log("Running pending migrations...");
  await runMigrations();
  console.log("Migrations complete.");
  await closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
