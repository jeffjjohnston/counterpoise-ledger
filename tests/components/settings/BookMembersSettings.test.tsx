import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookMembersSettings } from "@/components/settings/BookMembersSettings";
import { useBookRole, type BookMemberSummary } from "@/components/BookRoleProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";

const pushMock = vi.fn();
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useRouter: () => ({ push: pushMock }),
  })
);
vi.mock("@/components/BookRoleProvider", () => ({ useBookRole: vi.fn() }));

// One owner: a sole owner leaving would strand the book. Everything below
// assumes this shape unless a test passes its own member list.
const members: BookMemberSummary[] = [
  { userId: 1, username: "owner1", role: "owner", createdAt: "" },
  { userId: 2, username: "viewer2", role: "viewer", createdAt: "" },
];

// Two owners: either one can leave and the book keeps an owner.
const twoOwners: BookMemberSummary[] = [
  { userId: 1, username: "owner1", role: "owner", createdAt: "" },
  { userId: 3, username: "owner3", role: "owner", createdAt: "" },
];

function setRole(
  role: "owner" | "viewer",
  memberList: BookMemberSummary[] = members,
  userId: number | null = role === "owner" ? 1 : 2
) {
  const refresh = vi.fn();
  vi.mocked(useBookRole).mockReturnValue({
    books: [], currentBook: { id: 1, name: "B", upcomingDays: 30, userId: 1 }, currentUserId: userId, role, status: "ready",
    canWrite: role === "owner", isOwner: role === "owner", members: memberList, refresh,
  } as ReturnType<typeof useBookRole>);
  return refresh;
}

function stubFetch() {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSettings() {
  render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
}

// The confirm step is a modal with a heading. These find it and its buttons.
const dialogHeading = (name: string | RegExp) => screen.queryByRole("heading", { name });
const cancel = () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("BookMembersSettings", () => {
  it("shows the add form and role controls to an owner", () => {
    setRole("owner");
    render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Role for viewer2")).toBeInTheDocument();
  });

  it("posts a new member", async () => {
    setRole("owner");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ userId: 3, username: "new", role: "editor", createdAt: "" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "new" } });
    fireEvent.change(screen.getByLabelText("New member role"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ username: "new", role: "editor" });
  });

  it("shows a viewer the list and a Leave button only", () => {
    setRole("viewer");
    render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.getByText("viewer2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave book" })).toBeInTheDocument();
  });

  it("hides Leave book from a sole owner", () => {
    // The default `members` list has exactly one owner. Leaving would strand
    // the book with no owner, so an owner in this shape gets no Leave button.
    setRole("owner");
    render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
    expect(screen.queryByRole("button", { name: "Leave book" })).not.toBeInTheDocument();
  });

  it("shows Leave book to an owner with a co-owner", () => {
    setRole("owner", twoOwners);
    render(<ToastProvider><BookMembersSettings bookId="1" /></ToastProvider>);
    expect(screen.getByRole("button", { name: "Leave book" })).toBeInTheDocument();
  });

  describe("Remove", () => {
    it("asks first, and sends nothing on Cancel", async () => {
      setRole("owner");
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(dialogHeading("Remove viewer2?")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      cancel();
      expect(dialogHeading("Remove viewer2?")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("removes the member after the confirm", async () => {
      const refresh = setRole("owner");
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove member" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members/2", expect.objectContaining({ method: "DELETE" }))
      );
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(dialogHeading("Remove viewer2?")).not.toBeInTheDocument();
    });
  });

  describe("role change", () => {
    const threeMembers: BookMemberSummary[] = [
      { userId: 1, username: "owner1", role: "owner", createdAt: "" },
      { userId: 2, username: "viewer2", role: "viewer", createdAt: "" },
      { userId: 3, username: "owner3", role: "owner", createdAt: "" },
    ];

    it("changes another member between viewer and editor in one step", async () => {
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for viewer2"), { target: { value: "editor" } });

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members/2", expect.objectContaining({ method: "PUT" }))
      );
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ role: "editor" });
      expect(screen.queryByRole("button", { name: "Change role" })).not.toBeInTheDocument();
    });

    it("asks first before it demotes another owner, and sends nothing on Cancel", () => {
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for owner3"), { target: { value: "editor" } });
      expect(dialogHeading("Change the role of owner3?")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      cancel();
      expect(dialogHeading("Change the role of owner3?")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      // The select still shows the role that the server has.
      expect(screen.getByLabelText("Role for owner3")).toHaveValue("owner");
    });

    it("demotes another owner after the confirm", async () => {
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for owner3"), { target: { value: "editor" } });
      fireEvent.click(screen.getByRole("button", { name: "Change role" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members/3", expect.objectContaining({ method: "PUT" }))
      );
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ role: "editor" });
    });

    it("asks first before you change your own role, and sends nothing on Cancel", () => {
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for owner1"), { target: { value: "viewer" } });
      expect(dialogHeading("Change your own role?")).toBeInTheDocument();

      cancel();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("changes your own role after the confirm", async () => {
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for owner1"), { target: { value: "viewer" } });
      fireEvent.click(screen.getByRole("button", { name: "Change role" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members/1", expect.objectContaining({ method: "PUT" }))
      );
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ role: "viewer" });
    });

    it("asks first before it makes a member an owner", () => {
      // An owner can remove every other member, you included.
      setRole("owner", threeMembers);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.change(screen.getByLabelText("Role for viewer2"), { target: { value: "owner" } });
      expect(dialogHeading("Change the role of viewer2?")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Leave book", () => {
    it("asks first, and sends nothing on Cancel", () => {
      setRole("viewer");
      const fetchMock = stubFetch();
      const nativeConfirm = vi.spyOn(window, "confirm");
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Leave book" }));
      expect(dialogHeading("Leave this book?")).toBeInTheDocument();
      expect(nativeConfirm).not.toHaveBeenCalled();

      cancel();
      expect(dialogHeading("Leave this book?")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("removes you and goes to the book list after the confirm", async () => {
      setRole("viewer");
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Leave book" }));
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/books/1/members/2", expect.objectContaining({ method: "DELETE" }))
      );
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    });

    it("sends nothing and shows an error when the current user did not load", async () => {
      setRole("viewer", members, null);
      const fetchMock = stubFetch();
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Leave book" }));
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));

      expect(await screen.findByText(/Could not leave the book/)).toBeInTheDocument();
      expect(dialogHeading("Leave this book?")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });
  });
});
