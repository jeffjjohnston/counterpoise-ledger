import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { users } from "@/db/schema";
import { isRegistrationOpen } from "@/lib/registration";

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(() => {
  delete process.env.REGISTRATION_ENABLED;
});

describe("isRegistrationOpen", () => {
  it("is closed once a user exists and the flag is unset", async () => {
    // resetTestDatabase always seeds user id 1.
    await expect(isRegistrationOpen()).resolves.toBe(false);
  });

  it("is open while no user exists and the flag is unset", async () => {
    await db.delete(users).where(eq(users.id, 1));

    await expect(isRegistrationOpen()).resolves.toBe(true);
  });

  it("is open when explicitly enabled, even with users present", async () => {
    process.env.REGISTRATION_ENABLED = "true";

    await expect(isRegistrationOpen()).resolves.toBe(true);
  });

  it("is closed when explicitly disabled, even with no users", async () => {
    await db.delete(users).where(eq(users.id, 1));
    process.env.REGISTRATION_ENABLED = "false";

    await expect(isRegistrationOpen()).resolves.toBe(false);
  });
});
