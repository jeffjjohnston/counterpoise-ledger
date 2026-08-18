import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "path";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: resolve("/app/migrations") });
await sql.end();

console.log("Migrations complete.");
