"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { noteHtml } from "@/lib/wasm-client";

interface NoteIndicatorProps {
  notes: string;
}

// The popup's width (w-64), its distance from the icon, and the space it keeps
// from the edges of the window.
const TOOLTIP_WIDTH = 256;
const GAP = 8;
const EDGE = 8;
// The popup's own cap on its height (max-h-48).
const TOOLTIP_MAX_HEIGHT = 192;

type Placement = "above" | "below";

interface Position {
  top: number;
  left: number;
  placement: Placement;
  maxHeight: number;
}

/**
 * Where the popup goes for an icon at `anchor` and a popup `height` tall, in
 * window coordinates. It opens above the icon when it fits there, below when
 * it fits there, and otherwise on the side with more room, shortened to fit.
 * It is centered on the icon but kept inside the window.
 */
export function placeNoteTooltip(
  anchor: { top: number; bottom: number; left: number; right: number },
  height: number,
  viewport: { width: number; height: number }
): Position {
  const roomAbove = anchor.top - GAP - EDGE;
  const roomBelow = viewport.height - anchor.bottom - GAP - EDGE;
  let placement: Placement;
  if (height <= roomAbove) placement = "above";
  else if (height <= roomBelow) placement = "below";
  else placement = roomAbove >= roomBelow ? "above" : "below";
  const maxHeight = Math.max(0, placement === "above" ? roomAbove : roomBelow);
  const shown = Math.min(height, maxHeight);
  const top = placement === "above" ? anchor.top - GAP - shown : anchor.bottom + GAP;

  const center = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(EDGE, viewport.width - TOOLTIP_WIDTH - EDGE);
  const left = Math.min(Math.max(center - TOOLTIP_WIDTH / 2, EDGE), maxLeft);

  return { top, left, placement, maxHeight };
}

/**
 * The note icon of a register row, with the note in a popup on hover.
 *
 * The popup is rendered into document.body with fixed coordinates. The register
 * scrolls inside its own container, and some of its cells clip their content,
 * so a popup positioned inside the row was cut off: above the first rows it
 * went under the edge of the scroll container.
 */
export function NoteIndicator({ notes }: NoteIndicatorProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (showTooltip ? noteHtml(notes) : ""), [showTooltip, notes]);

  // Measure before the paint, so the popup never shows in the wrong place.
  // Measure again when the note changes size after that: an image in the
  // Markdown loads later and makes the popup taller.
  useLayoutEffect(() => {
    if (!showTooltip) {
      setPosition(null);
      return;
    }
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    const content = contentRef.current;
    if (!anchor || !tooltip || !content) return;
    const place = () => {
      // The height the popup wants, not the height it has: once placed, its
      // max-height can cut it shorter than the note.
      const chrome = tooltip.offsetHeight - tooltip.clientHeight;
      const height = Math.min(TOOLTIP_MAX_HEIGHT, tooltip.scrollHeight + chrome);
      setPosition(
        placeNoteTooltip(anchor.getBoundingClientRect(), height, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      );
    };
    place();
    // jsdom and very old browsers have no ResizeObserver. The first place stays.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(content);
    return () => observer.disconnect();
  }, [showTooltip, notes]);

  // The coordinates are fixed, so the popup would stay behind when the list
  // scrolls or the window changes size. Close it instead, except for a scroll
  // inside the popup itself (a long note).
  useEffect(() => {
    if (!showTooltip) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && tooltipRef.current?.contains(event.target)) return;
      setShowTooltip(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [showTooltip]);

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={(e) => e.stopPropagation()}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4 text-fg-tertiary hover:text-fg-secondary transition-colors shrink-0"
        aria-label="Has notes"
      >
        <path
          fillRule="evenodd"
          d="M4.5 2A1.5 1.5 0 003 3.5v13A1.5 1.5 0 004.5 18h11a1.5 1.5 0 001.5-1.5V7.621a1.5 1.5 0 00-.44-1.06l-4.12-4.122A1.5 1.5 0 0011.378 2H4.5zm2.25 8.5a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 3a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"
          clipRule="evenodd"
        />
      </svg>
      {showTooltip &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            data-placement={position?.placement}
            className="fixed z-50 w-64 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg p-3 text-sm text-fg prose prose-sm dark:prose-invert max-w-none"
            style={
              position
                ? { top: position.top, left: position.left, maxHeight: Math.min(TOOLTIP_MAX_HEIGHT, position.maxHeight) }
                : { top: 0, left: 0, visibility: "hidden" }
            }
            onClick={(e) => e.stopPropagation()}
          >
            {/* noteHtml drops raw HTML and unsafe link targets. */}
            <div ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
          </div>,
          document.body
        )}
    </span>
  );
}
