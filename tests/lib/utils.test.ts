import { describe, it, expect, vi } from "vitest";
import { cn, selectInputContents } from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes via clsx", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  it("resolves Tailwind conflicts (last wins)", () => {
    const result = cn("px-4", "px-6");
    expect(result).toBe("px-6");
  });

  it("handles undefined and null inputs", () => {
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });

  it("handles empty call", () => {
    expect(cn()).toBe("");
  });
});

describe("selectInputContents", () => {
  it("selects the input's full contents", () => {
    const input = document.createElement("input");
    input.value = "123.45";
    document.body.appendChild(input);

    selectInputContents(input);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("123.45".length);
    input.remove();
  });

  it("ignores InvalidStateError from input types that do not support selection", () => {
    const input = document.createElement("input");
    vi.spyOn(input, "select").mockImplementation(() => {
      throw new DOMException("not supported", "InvalidStateError");
    });

    expect(() => selectInputContents(input)).not.toThrow();
  });

  it("rethrows unexpected errors from select()", () => {
    const input = document.createElement("input");
    vi.spyOn(input, "select").mockImplementation(() => {
      throw new TypeError("unexpected bug");
    });

    expect(() => selectInputContents(input)).toThrow("unexpected bug");
  });
});
