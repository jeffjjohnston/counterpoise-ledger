import { cn } from "@/lib/utils";

/** Shows that the book has a new feature that the user can turn on. */
export function NewFeatureDot({ corner = false }: { corner?: boolean }) {
  return (
    <span
      data-testid="new-feature-dot"
      aria-label="New feature available"
      role="img"
      className={cn("inline-block w-2 h-2 rounded-full bg-accent", corner && "absolute top-1.5 right-1.5")}
    />
  );
}
