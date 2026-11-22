import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { AccountRedirect } from "@/client/AccountRedirect";

describe("AccountRedirect", () => {
  it("/account redirects to /settings#account", async () => {
    function Where() {
      const location = useLocation();
      return <p>{`${location.pathname}${location.hash}`}</p>;
    }
    const router = createMemoryRouter(
      [
        { path: "account", Component: AccountRedirect },
        { path: "settings", Component: Where },
      ],
      { initialEntries: ["/account"] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("/settings#account")).toBeInTheDocument();
  });
});
