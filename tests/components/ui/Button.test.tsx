import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "@/components/ui/Button";

describe("Button", () => {
  it("exposes its label and invokes the supplied action", () => {
    const click = vi.fn();
    render(<Button onClick={click}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the action when disabled", () => {
    const click = vi.fn();
    render(<Button disabled onClick={click}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });

  it("submits the containing form when requested", () => {
    const submit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={submit}><Button type="submit">Save</Button></form>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("lets a caller override a utility class", () => {
    render(<Button className="px-12">Save</Button>);
    expect(screen.getByRole("button")).toHaveClass("px-12");
    expect(screen.getByRole("button")).not.toHaveClass("px-4");
  });
});
