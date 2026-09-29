import { Outlet } from "react-router";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { BookRoleProvider } from "@/components/BookRoleProvider";
import { BookNavbar } from "@/components/layout/BookNavbar";
import { LastPostgresNotice } from "@/components/layout/LastPostgresNotice";
import { KeyboardShortcutProvider } from "@/components/KeyboardShortcutProvider";
import { KeyboardShortcutOverlay } from "@/components/ui/KeyboardShortcutOverlay";
import { WebMcpTools } from "@/components/WebMcpTools";

/** The layout route of `/b/:bookId` in `client/routes.tsx`. */
export default function BookLayout() {
  return (
    <KeyboardShortcutProvider>
      <WebMcpTools />
      <BookChangesProvider>
        <BookRoleProvider>
          <BookNavbar />
          <main>
            <Outlet />
          </main>
          <LastPostgresNotice />
        </BookRoleProvider>
      </BookChangesProvider>
      <KeyboardShortcutOverlay />
    </KeyboardShortcutProvider>
  );
}
