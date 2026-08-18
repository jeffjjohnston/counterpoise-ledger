import { BookNavbar } from "@/components/layout/BookNavbar";
import { KeyboardShortcutProvider } from "@/components/KeyboardShortcutProvider";
import { KeyboardShortcutOverlay } from "@/components/ui/KeyboardShortcutOverlay";

export default function BookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <KeyboardShortcutProvider>
      <BookNavbar />
      <main>{children}</main>
      <KeyboardShortcutOverlay />
    </KeyboardShortcutProvider>
  );
}
