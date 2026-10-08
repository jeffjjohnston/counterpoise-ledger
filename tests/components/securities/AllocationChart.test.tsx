import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AllocationChart } from "@/components/securities/AllocationChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AllocationChart", () => {
  it("has the title Allocation", () => {
    render(
      <AllocationChart securities={[
        { id: 1, symbol: "VTI", name: "VTI fund", marketValueCents: 75_000 },
        { id: 2, symbol: "BND", name: "BND fund", marketValueCents: 25_000 },
      ]} />,
    );
    expect(screen.getByRole("heading", { name: "Allocation" })).toBeInTheDocument();
  });
});
