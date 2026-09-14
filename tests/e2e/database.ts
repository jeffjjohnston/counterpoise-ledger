import { assertTestDatabaseUrl } from "../helpers/database-safety";

export function e2eDatabaseUrl() {
  const url = process.env.E2E_DATABASE_URL ??
    "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_e2e";
  assertTestDatabaseUrl(url, "counterpoise_e2e");
  return url;
}
