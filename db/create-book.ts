import { resolve } from "path";

/** Path to migration files, resolved from project root. */
export const MIGRATIONS_FOLDER = resolve(process.cwd(), "db", "migrations");
