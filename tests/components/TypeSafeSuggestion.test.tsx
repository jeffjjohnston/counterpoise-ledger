import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTypeSafeSuggestion } from "@/hooks/useTypeSafeSuggestion";
import { notifyTypeSafeSettings } from "@/lib/typesafe/events";
import { TypeSafeSuggestion } from "@/components/sync/TypeSafeSuggestion";

afterEach(() => {
  vi.unstubAllGlobals();
});
function Harness({ row = 10 }: { row?: number }) {
  const suggestion = useTypeSafeSuggestion("1", 2, row, true);
  return (
    <p>
      {suggestion.result?.status === "ready"
        ? `Suggestion ${suggestion.result.transactionId}`
        : "No suggestion"}
    </p>
  );
}

describe("TypeSafe suggestions", () => {
  it("never requests evaluations when the book is off", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ enabled: false, configured: true, revision: 0 }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(
      true,
    );
  });
  it("hides a displayed suggestion on disable and discards an old row's delayed response", async () => {
    let enabled = true;
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/settings/typesafe"))
          return new Response(
            JSON.stringify({
              enabled,
              configured: true,
              revision: enabled ? 1 : 2,
            }),
          );
        if (init?.method === "PATCH") return new Response("{}");
        if (JSON.parse(init?.body as string).reconciliationId === 11)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return new Response(
          JSON.stringify({
            status: "ready",
            revision: 1,
            transactionId: 7,
            evaluationId: 1,
          }),
        );
      }),
    );
    const view = render(<Harness />);
    expect(await screen.findByText("Suggestion 7")).toBeVisible();
    enabled = false;
    act(() => notifyTypeSafeSettings("1"));
    expect(screen.getByText("No suggestion")).toBeVisible();
    enabled = true;
    view.rerender(<Harness row={11} />);
    await waitFor(() => expect(release).toBeDefined());
    view.rerender(<Harness row={12} />);
    expect(await screen.findByText("Suggestion 7")).toBeVisible();
    await act(async () =>
      release(
        new Response(
          JSON.stringify({
            status: "ready",
            revision: 1,
            transactionId: 99,
            evaluationId: 2,
          }),
        ),
      ),
    );
    expect(screen.queryByText("Suggestion 99")).not.toBeInTheDocument();
  });
  it("only invokes matching when the user presses the suggestion button", () => {
    const onMatch = vi.fn();
    render(
      <TypeSafeSuggestion
        result={{
          status: "ready",
          evaluationId: 4,
          revision: 1,
          transactionId: 7,
        }}
        candidates={[
          {
            transactionId: 7,
            date: "2026-09-16",
            payeeName: "Coffee",
            description: null,
            checkNumber: null,
            linkedSplitAmount: -1500,
            expectedAmount: -1500,
            amountDelta: 0,
            dayDelta: 0,
            counterpartAccountNames: [],
            splitCount: 2,
            score: 100,
            scoreTags: [],
            alreadyLinked: false,
          },
        ]}
        loading={false}
        submitting={false}
        onMatch={onMatch}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(onMatch).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Match this transaction" }),
    );
    expect(onMatch).toHaveBeenCalledWith(4);
  });

  it("shows a proposal with Create and Edit, and calls each only on click", () => {
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const proposal = {
      payee: { name: "SQ BLUE BOTTLE", payeeId: null },
      category: { accountId: 7, name: "Food:Dining" },
    };
    render(
      <TypeSafeSuggestion
        result={{
          status: "ready",
          evaluationId: 5,
          revision: 1,
          transactionId: null,
          proposal,
        }}
        candidates={[]}
        loading={false}
        submitting={false}
        onMatch={vi.fn()}
        onCreate={onCreate}
        onEdit={onEdit}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("No existing transaction matches.")).toBeVisible();
    expect(screen.getByText("SQ BLUE BOTTLE")).toBeVisible();
    expect(screen.getByText("(new payee)")).toBeVisible();
    expect(screen.getByText("Food:Dining")).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create transaction" }));
    expect(onCreate).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(onEdit).toHaveBeenCalledWith(proposal);
  });

  it("shows a no-suggestion message when there were no candidates to match against", () => {
    render(
      <TypeSafeSuggestion
        result={{ status: "ready", evaluationId: 5, revision: 1, transactionId: null, proposal: null }}
        candidates={[]}
        loading={false}
        submitting={false}
        onMatch={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("TypeSafe has no suggestion for this transaction."),
    ).toBeVisible();
    expect(
      screen.queryByText("TypeSafe found no clear match among these candidates."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Create transaction" })).toBeNull();
  });

  it("keeps the no-clear-match text when there were candidates but none matched", () => {
    render(
      <TypeSafeSuggestion
        result={{ status: "ready", evaluationId: 5, revision: 1, transactionId: null, proposal: null }}
        candidates={[
          {
            transactionId: 7,
            date: "2026-09-16",
            payeeName: "Coffee",
            description: null,
            checkNumber: null,
            linkedSplitAmount: -1500,
            expectedAmount: -1500,
            amountDelta: 0,
            dayDelta: 0,
            counterpartAccountNames: [],
            splitCount: 2,
            score: 100,
            scoreTags: [],
            alreadyLinked: false,
          },
        ]}
        loading={false}
        submitting={false}
        onMatch={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("TypeSafe found no clear match among these candidates."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create transaction" })).toBeNull();
  });
});
