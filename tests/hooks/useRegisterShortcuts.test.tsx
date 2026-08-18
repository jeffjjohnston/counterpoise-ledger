import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRegisterShortcuts } from "@/hooks/useRegisterShortcuts";
import type { ShortcutDef } from "@/components/KeyboardShortcutProvider";

const mockUnregister = vi.fn();
const mockRegisterShortcuts = vi.fn().mockReturnValue(mockUnregister);

vi.mock("@/components/KeyboardShortcutProvider", () => ({
  useKeyboardShortcuts: () => ({
    registerShortcuts: mockRegisterShortcuts,
  }),
}));

const testShortcuts: ShortcutDef[] = [
  {
    id: "test-shortcut",
    keys: ["n"],
    description: "Test shortcut",
    category: "Test",
    action: vi.fn(),
  },
];

describe("useRegisterShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisterShortcuts.mockReturnValue(mockUnregister);
  });

  it("registers shortcuts on mount", () => {
    renderHook(() => useRegisterShortcuts(testShortcuts));
    expect(mockRegisterShortcuts).toHaveBeenCalledWith(testShortcuts);
    expect(mockRegisterShortcuts).toHaveBeenCalledTimes(1);
  });

  it("unregisters shortcuts on unmount", () => {
    const { unmount } = renderHook(() => useRegisterShortcuts(testShortcuts));
    expect(mockUnregister).not.toHaveBeenCalled();
    unmount();
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });

  it("does not register when shortcuts array is empty", () => {
    renderHook(() => useRegisterShortcuts([]));
    expect(mockRegisterShortcuts).not.toHaveBeenCalled();
  });
});
