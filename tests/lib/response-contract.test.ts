import { describe, expect, it } from "vitest";
import { assertResponseContract, inContract } from "../helpers/contract";

const version = { version: "1.2.3" };

describe("the response contract check of the HTTP test client", () => {
  it("finds an operation by its method and a path with parameters", () => {
    expect(inContract("GET", "/api/version")).toBe(true);
    expect(inContract("get", "/api/b/12/accounts/345")).toBe(true);
    // One parameter takes one segment only.
    expect(inContract("GET", "/api/b/12/accounts/345/extra")).toBe(false);
    expect(inContract("DELETE", "/api/version")).toBe(false);
    expect(inContract("GET", "/api/cron/backup")).toBe(false);
  });

  // `/securities/prices-due` also has the form of `/securities/{id}`. The
  // router gives it to its own route, so its own schema judges the body.
  it("gives a path to the route with the literal segment, as the router does", () => {
    expect(() => assertResponseContract("GET", "/api/b/1/securities/prices-due", 200, "not a body"))
      .toThrow(/the contract of GET \/api\/b\/\{bookId\}\/securities\/prices-due /);
    expect(() => assertResponseContract("GET", "/api/b/1/securities/7", 200, "not a body"))
      .toThrow(/the contract of GET \/api\/b\/\{bookId\}\/securities\/\{id\} /);
  });

  it("accepts a body that matches the schema of the operation", () => {
    expect(() => assertResponseContract("GET", "/api/b/1/accounts", 200, [])).not.toThrow();
  });

  it("refuses a body with a wrong type, and names the operation", () => {
    expect(() => assertResponseContract("GET", "/api/b/1/accounts", 200, { rows: [] }))
      .toThrow(/GET \/api\/b\/1\/accounts does not match the contract of GET \/api\/b\/\{bookId\}\/accounts/);
  });

  it("refuses a key that the schema does not declare", () => {
    expect(() => assertResponseContract("GET", "/api/version", 200, { ...version, extra: true })).toThrow(/additional properties/);
  });

  it("does not judge an error response or a route outside the document", () => {
    expect(() => assertResponseContract("GET", "/api/b/1/accounts", 404, { anything: 1 })).not.toThrow();
    expect(() => assertResponseContract("GET", "/api/cron/backup", 200, { anything: 1 })).not.toThrow();
  });
});
