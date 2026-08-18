import { cn } from "@/lib/utils";

interface CategoryIconProps {
  /** A resolved icon from `buildCategoryLabelMap`, or null to render nothing. */
  icon: string | null;
  className?: string;
}

/**
 * The only place that knows a category icon is an emoji.
 *
 * Everything else passes an opaque string through, so swapping to an SVG set
 * later is a change to this file alone.
 *
 * The fixed-width box matters: emoji glyph widths vary by platform and font,
 * and without it the text beside the icon would sit at a different offset on
 * every row — which is the opposite of the anchoring this feature is for.
 * The default right margin is a separate concern: it guards against a glyph
 * that renders wider than the box (some palette entries, or the four-person
 * family ZWJ sequence) running into the text that follows. A caller whose
 * icon has no adjacent text — the picker's palette grid — overrides it back
 * to `mr-0` via `className`, since centering there would shift otherwise.
 *
 * `aria-hidden` is deliberate. The category name is rendered right beside the
 * icon, so a screen reader announcing "automobile Gasoline" is worse than
 * "Gasoline".
 */
export function CategoryIcon({ icon, className }: CategoryIconProps) {
  if (!icon) return null;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block w-[1.35em] mr-1 flex-shrink-0 text-center select-none",
        className
      )}
    >
      {icon}
    </span>
  );
}
