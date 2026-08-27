import { BookNavbar } from "@/components/layout/BookNavbar";
import { KeyboardShortcutProvider } from "@/components/KeyboardShortcutProvider";
import { KeyboardShortcutOverlay } from "@/components/ui/KeyboardShortcutOverlay";
import { WebMcpTools } from "@/components/WebMcpTools";

export default function BookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <KeyboardShortcutProvider>
      <WebMcpTools />
      <BookNavbar />
      <main>{children}</main>
      <KeyboardShortcutOverlay />
    </KeyboardShortcutProvider>
  );
}
