import { describe, expect, it } from "vitest";
import { workerZone } from "./http-parity";

describe("workerZone", () => {
  const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;

  it("uses the zone of the test first", () => {
    expect(workerZone("Asia/Tokyo", "America/New_York")).toBe("Asia/Tokyo");
  });

  it("uses the TZ of the process when the test names no zone", () => {
    expect(workerZone(undefined, "America/New_York")).toBe("America/New_York");
  });

  // A Worker has no system zone. With an empty APP_TZ it runs on UTC, and
  // the tests compute their dates in the zone of the machine.
  it("uses the zone of the machine when TZ is not set", () => {
    expect(workerZone(undefined, undefined)).toBe(machine);
    expect(workerZone(undefined, "")).toBe(machine);
    expect(machine).not.toBe("");
  });
});
