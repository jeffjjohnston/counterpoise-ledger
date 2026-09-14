import { beforeAll, expect, it } from "vitest";
import { setupTestDatabase } from "../helpers/db-utils";
import { leaseTestDatabase, workerDatabaseUrl } from "../helpers/database-safety";

beforeAll(setupTestDatabase);
it("refuses a second runner before it can reset an occupied worker database", async () => {
  const url = workerDatabaseUrl();
  await expect(leaseTestDatabase(url, new URL(url).pathname.slice(1))).rejects.toThrow(/already in use/);
});
