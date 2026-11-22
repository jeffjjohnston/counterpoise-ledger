import { describe, expect, it } from "vitest";
import { activeSection } from "@/components/settings/useActiveSection";

// Each section is 300px high. The first section starts at `firstTop`.
const sections = (firstTop: number) =>
  ["features", "general", "device"].map((id, index) => ({
    id,
    top: firstTop + index * 300,
    bottom: firstTop + (index + 1) * 300,
  }));

describe("activeSection", () => {
  it("is the first section at the top of the page", () => {
    expect(activeSection(sections(120), 100, false)).toBe("features");
  });

  it("changes when a section goes fully above the line", () => {
    // The bottom of "features" is at 101: one pixel is below the line.
    expect(activeSection(sections(-199), 100, false)).toBe("features");
    expect(activeSection(sections(-200), 100, false)).toBe("general");
  });

  it("is the last section at the end of the page", () => {
    expect(activeSection(sections(-250), 100, true)).toBe("device");
  });

  it("is the first section when the sections have no layout", () => {
    const flat = ["features", "general"].map((id) => ({ id, top: 0, bottom: 0 }));
    expect(activeSection(flat, 100, false)).toBe("features");
  });

  it("is null with no sections", () => {
    expect(activeSection([], 100, false)).toBeNull();
  });
});
