import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBookId } from "@/hooks/useBookId";

vi.mock("next/navigation", () => ({
  useParams: vi.fn().mockReturnValue({ bookId: "42" }),
}));

describe("useBookId", () => {
  it("returns bookId from route params", () => {
    const { result } = renderHook(() => useBookId());
    expect(result.current).toBe("42");
  });
});
