import { describe, it, expect, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SaveChordSettings } from "@/components/settings/SaveChordSettings";
import { SAVE_CHORD_KEY } from "@/lib/save-chord";

describe("SaveChordSettings", () => {
  afterEach(() => localStorage.clear());

  it("is off by default", () => {
    render(<SaveChordSettings />);
    expect(screen.getByRole("checkbox", { name: "Play a chord when a transaction saves" })).not.toBeChecked();
  });

  it("keeps the choice for this device across reopening", () => {
    const { unmount } = render(<SaveChordSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Play a chord when a transaction saves" }));
    expect(localStorage.getItem(SAVE_CHORD_KEY)).toBe("true");
    unmount();

    render(<SaveChordSettings />);
    const checkbox = screen.getByRole("checkbox", { name: "Play a chord when a transaction saves" });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(localStorage.getItem(SAVE_CHORD_KEY)).toBe("false");
  });
});
