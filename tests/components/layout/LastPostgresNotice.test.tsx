import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DISMISSED_KEY,
  LastPostgresNotice,
  UPGRADE_GUIDE_URL,
} from "@/components/layout/LastPostgresNotice";

const notice = () => screen.queryByRole("complementary", { name: "Upgrade notice" });

describe("LastPostgresNotice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("tells the user that this is the last PostgreSQL release", () => {
    render(<LastPostgresNotice />);

    expect(notice()).toHaveTextContent(
      "This is the last Counterpoise release that uses PostgreSQL. The next release moves " +
        "your data to SQLite. That upgrade needs a one-time conversion. Read the upgrade " +
        "guide before you upgrade."
    );
  });

  it("links to the upgrade guide on the public mirror in a new tab", () => {
    render(<LastPostgresNotice />);

    const link = screen.getByRole("link", { name: "upgrade guide" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/jeffjjohnston/counterpoise-ledger/blob/main/guides/upgrade-to-sqlite.md"
    );
    expect(link).toHaveAttribute("href", UPGRADE_GUIDE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides when the user dismisses it, and stays hidden after a reload", () => {
    const { unmount } = render(<LastPostgresNotice />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss the upgrade notice" }));

    expect(notice()).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("true");

    unmount();
    render(<LastPostgresNotice />);
    expect(notice()).not.toBeInTheDocument();
  });

  it("shows when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(<LastPostgresNotice />);

    expect(notice()).toBeInTheDocument();
  });

  it("hides for this page when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    render(<LastPostgresNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the upgrade notice" }));

    expect(notice()).not.toBeInTheDocument();
  });
});
