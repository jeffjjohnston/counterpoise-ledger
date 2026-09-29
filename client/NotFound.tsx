import { EmptyState } from "@/components/ui/EmptyState";

/** A path that no route has. The Rust server sends index.html for it. */
export function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <EmptyState
        title="Page not found"
        description="This page does not exist."
        action={{ label: "Go to your books", href: "/" }}
      />
    </div>
  );
}
