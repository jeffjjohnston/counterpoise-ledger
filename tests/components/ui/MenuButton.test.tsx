import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MenuButton } from "@/components/ui/MenuButton";

describe("MenuButton", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is closed until the trigger is pressed", () => {
    render(<MenuButton items={[{ label: "Reset", onSelect: vi.fn() }]} />);
    expect(screen.queryByRole("menu")).toBeNull();
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on click and runs the selected item, then closes", () => {
    const onSelect = vi.fn();
    render(<MenuButton items={[{ label: "Reset", onSelect }]} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Reset" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape without running anything", () => {
    const onSelect = vi.fn();
    render(<MenuButton items={[{ label: "Reset", onSelect }]} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on an outside click", () => {
    render(
      <div>
        <MenuButton items={[{ label: "Reset", onSelect: vi.fn() }]} />
        <button type="button">elsewhere</button>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run a disabled item", () => {
    const onSelect = vi.fn();
    render(<MenuButton items={[{ label: "Reset", onSelect, disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses a custom accessible name when given one", () => {
    render(
      <MenuButton
        label="Chase Bank actions"
        items={[{ label: "Reset", onSelect: vi.fn() }]}
      />
    );
    expect(
      screen.getByRole("button", { name: "Chase Bank actions" })
    ).toBeInTheDocument();
  });
});
