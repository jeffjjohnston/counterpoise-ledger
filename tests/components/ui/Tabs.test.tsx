import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabs } from "@/components/ui/Tabs";

describe("Tabs", () => {
  const tabs = [
    { id: "one", label: "Tab One", content: <div>Content One</div> },
    { id: "two", label: "Tab Two", content: <div>Content Two</div> },
    { id: "three", label: "Tab Three", content: <div>Content Three</div> },
  ];

  it("renders all tab labels", () => {
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={vi.fn()} />);
    expect(screen.getByText("Tab One")).toBeInTheDocument();
    expect(screen.getByText("Tab Two")).toBeInTheDocument();
    expect(screen.getByText("Tab Three")).toBeInTheDocument();
  });

  it("renders only the active tab content", () => {
    render(<Tabs tabs={tabs} activeTab="two" onTabChange={vi.fn()} />);
    expect(screen.getByText("Content Two")).toBeInTheDocument();
    expect(screen.queryByText("Content One")).not.toBeInTheDocument();
    expect(screen.queryByText("Content Three")).not.toBeInTheDocument();
  });

  it("calls onTabChange when a tab is clicked", () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText("Tab Three"));
    expect(onTabChange).toHaveBeenCalledWith("three");
  });

  it("applies active styling to the selected tab", () => {
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={vi.fn()} />);
    const activeButton = screen.getByText("Tab One");
    expect(activeButton.className).toContain("border-accent");
  });

  it("applies inactive styling to non-selected tabs", () => {
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={vi.fn()} />);
    const inactiveButton = screen.getByText("Tab Two");
    expect(inactiveButton.className).toContain("border-transparent");
  });
});
