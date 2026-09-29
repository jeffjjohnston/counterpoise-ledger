import { describe, it, expect } from "vitest";
import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  Link,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  type AppRouter,
} from "@/lib/navigation";

// The shim against a real router. The component tests mock it, so these are
// the only tests of what it gives.

let router: AppRouter | undefined;

function Probe() {
  const current = useRouter();
  // Hand the router to the test after each render.
  useEffect(() => {
    router = current;
  });
  const { bookId } = useParams<{ bookId: string }>();
  const searchParams = useSearchParams();
  return (
    <>
      <output aria-label="pathname">{usePathname()}</output>
      <output aria-label="book">{bookId}</output>
      <output aria-label="account">{searchParams.get("accountId") ?? ""}</output>
      <Link href="/b/7/payees" className="nav">
        Payees
      </Link>
    </>
  );
}

function renderAt(path: string) {
  const memory = createMemoryRouter(
    [
      { path: "/b/:bookId/*", Component: Probe },
      { path: "*", Component: Probe },
    ],
    { initialEntries: [path] }
  );
  render(<RouterProvider router={memory} />);
  return memory;
}

describe("navigation shim", () => {
  it("reads the path, the dynamic segments and the query", () => {
    renderAt("/b/5/transactions?accountId=12");
    expect(screen.getByLabelText("pathname")).toHaveTextContent("/b/5/transactions");
    expect(screen.getByLabelText("book")).toHaveTextContent("5");
    expect(screen.getByLabelText("account")).toHaveTextContent("12");
  });

  it("renders Link as an anchor with its href and attributes, and navigates on click", () => {
    const memory = renderAt("/b/5/transactions");
    const link = screen.getByRole("link", { name: "Payees" });
    expect(link).toHaveAttribute("href", "/b/7/payees");
    expect(link).toHaveClass("nav");

    fireEvent.click(link);
    expect(memory.state.location.pathname).toBe("/b/7/payees");
  });

  it("push adds a history entry and replace does not", async () => {
    const memory = renderAt("/b/5/transactions");
    await act(async () => router!.push("/b/5/accounts"));
    expect(memory.state.location.pathname).toBe("/b/5/accounts");
    expect(memory.state.historyAction).toBe("PUSH");

    await act(async () => router!.replace("/b/5/search?q=rent", { scroll: false }));
    expect(memory.state.location.pathname).toBe("/b/5/search");
    expect(memory.state.historyAction).toBe("REPLACE");
    expect(screen.getByLabelText("pathname")).toHaveTextContent("/b/5/search");
  });

  it("maps scroll: false to preventScrollReset", async () => {
    const memory = renderAt("/b/5/transactions");
    await act(async () => router!.push("/b/5/accounts", { scroll: false }));
    expect(memory.state.preventScrollReset).toBe(true);

    await act(async () => router!.push("/b/5/payees"));
    expect(memory.state.preventScrollReset).toBe(false);
  });

  it("gives the same router object on each render", async () => {
    renderAt("/b/5/transactions");
    const first = router;
    await act(async () => router!.replace("/b/5/transactions?accountId=3"));
    expect(screen.getByLabelText("account")).toHaveTextContent("3");
    expect(router).toBe(first);
  });
});
