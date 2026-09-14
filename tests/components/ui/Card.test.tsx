import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";

describe("Card", () => {
  it("renders a named section, heading, content, and header action", () => {
    render(
      <Card role="region" aria-labelledby="balance">
        <CardHeader action={<a href="/reports">View reports</a>}>
          <CardTitle id="balance">Balance</CardTitle>
        </CardHeader>
        <CardContent>$125.00</CardContent>
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Balance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Balance", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View reports" })).toHaveAttribute("href", "/reports");
  });
});
