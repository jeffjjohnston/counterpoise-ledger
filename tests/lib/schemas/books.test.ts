import { describe, it, expect } from "vitest";
import { createBookSchema, updateBookSchema } from "@/lib/schemas/books";

describe("createBookSchema", () => {
  it("accepts a valid name", () => {
    const r = createBookSchema.safeParse({ name: "Household" });
    expect(r.success).toBe(true);
  });

  it("trims the stored name", () => {
    const r = createBookSchema.safeParse({ name: "  Household  " });
    expect(r.success).toBe(true);
    expect(r.data!.name).toBe("Household");
  });

  it("rejects a missing name with the ported message", () => {
    const r = createBookSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });

  it("rejects a whitespace-only name with the ported message", () => {
    const r = createBookSchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });

  it("rejects a non-string name with the ported message", () => {
    const r = createBookSchema.safeParse({ name: 123 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = createBookSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });
});

describe("updateBookSchema", () => {
  it("accepts a name-only update", () => {
    const r = updateBookSchema.safeParse({ name: "Renamed" });
    expect(r.success).toBe(true);
    expect(r.data!.upcomingDays).toBeUndefined();
  });

  it("accepts a name with a valid upcomingDays", () => {
    const r = updateBookSchema.safeParse({ name: "Renamed", upcomingDays: 45 });
    expect(r.success).toBe(true);
    expect(r.data!.upcomingDays).toBe(45);
  });

  it("accepts the boundary values 1 and 365", () => {
    expect(updateBookSchema.safeParse({ name: "Book", upcomingDays: 1 }).success).toBe(true);
    expect(updateBookSchema.safeParse({ name: "Book", upcomingDays: 365 }).success).toBe(true);
  });

  it("rejects a missing name even when upcomingDays is valid", () => {
    const r = updateBookSchema.safeParse({ upcomingDays: 30 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });

  it("rejects upcomingDays below the range", () => {
    const r = updateBookSchema.safeParse({ name: "Book", upcomingDays: 0 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "upcomingDays must be an integer between 1 and 365"
    );
  });

  it("rejects upcomingDays above the range", () => {
    const r = updateBookSchema.safeParse({ name: "Book", upcomingDays: 366 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "upcomingDays must be an integer between 1 and 365"
    );
  });

  it("rejects a non-integer upcomingDays", () => {
    const r = updateBookSchema.safeParse({ name: "Book", upcomingDays: 30.5 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "upcomingDays must be an integer between 1 and 365"
    );
  });

  it("rejects a non-numeric upcomingDays", () => {
    const r = updateBookSchema.safeParse({ name: "Book", upcomingDays: "30" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "upcomingDays must be an integer between 1 and 365"
    );
  });

  it("rejects an explicit null upcomingDays (not treated as absent)", () => {
    const r = updateBookSchema.safeParse({ name: "Book", upcomingDays: null });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "upcomingDays must be an integer between 1 and 365"
    );
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = updateBookSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Book name is required");
  });
});
