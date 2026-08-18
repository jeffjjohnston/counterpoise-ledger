import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Toast } from "@/components/ui/Toast";

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders message text", () => {
    render(<Toast message="Saved!" isVisible={true} onDismiss={vi.fn()} />);
    expect(screen.getByText("Saved!")).toBeInTheDocument();
  });

  it("has visible styling when isVisible is true", () => {
    const { container } = render(
      <Toast message="Saved!" isVisible={true} onDismiss={vi.fn()} />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("opacity-100");
  });

  it("preserves newlines in multi-line messages", () => {
    const { container } = render(
      <Toast
        message={"Created 1 transaction(s)\n\nSkipped 1 rule(s): reason"}
        isVisible={true}
        onDismiss={vi.fn()}
      />
    );
    const pill = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(pill.className).toContain("whitespace-pre-line");
  });

  it("has hidden styling when isVisible is false", () => {
    const { container } = render(
      <Toast message="Saved!" isVisible={false} onDismiss={vi.fn()} />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("pointer-events-none");
  });

  it("calls onDismiss after duration", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Done" isVisible={true} onDismiss={onDismiss} duration={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("defaults to 2000ms duration", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Done" isVisible={true} onDismiss={onDismiss} />);
    vi.advanceTimersByTime(1999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not fire timer when not visible", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Done" isVisible={false} onDismiss={onDismiss} />);
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
