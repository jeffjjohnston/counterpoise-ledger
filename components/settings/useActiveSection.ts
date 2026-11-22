"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SectionBox = { id: string; top: number; bottom: number };

/** The distance from the top of the window to the line that a section must
 * cross to be the active one. It is a little below the `scroll-mt-24` of a
 * section, so a section that a link scrolled to is active. */
export const ACTIVE_LINE = 100;

/**
 * The id of the section that the user reads: the first section with its
 * bottom below `line`. At the end of the page that is the last section,
 * because a short last section cannot get to the line. With no layout (all
 * boxes are empty) it is the first section. `sections` is in page order.
 */
export function activeSection(sections: SectionBox[], line: number, atEnd: boolean): string | null {
  if (sections.length === 0) return null;
  if (atEnd) return sections[sections.length - 1].id;
  return (sections.find((section) => section.bottom > line) ?? sections[0]).id;
}

/**
 * Follows the scroll position and gives the id of the active section.
 * `pin(id)` makes a section active when a link goes to it: a section near
 * the end of the page stops below the line, and the measurement alone would
 * then show the section before it. The pin ends when the section goes off
 * the screen.
 */
export function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const pinned = useRef<string | null>(null);
  const idList = ids.join(",");

  const measure = useCallback(() => {
    const boxes: SectionBox[] = [];
    for (const id of idList.split(",")) {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      if (rect) boxes.push({ id, top: rect.top, bottom: rect.bottom });
    }
    const pin = boxes.find((box) => box.id === pinned.current);
    if (pin && pin.top >= 0 && pin.top <= window.innerHeight) {
      setActive(pin.id);
      return;
    }
    pinned.current = null;
    const page = document.documentElement;
    const atEnd = page.scrollHeight > window.innerHeight
      && window.scrollY + window.innerHeight >= page.scrollHeight - 2;
    setActive(activeSection(boxes, ACTIVE_LINE, atEnd));
  }, [idList]);

  useEffect(() => {
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    // The capture phase also gets the scroll of an element inside the page.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [measure]);

  const pin = useCallback((id: string) => {
    pinned.current = id;
    setActive(id);
  }, []);

  return { active, pin };
}
