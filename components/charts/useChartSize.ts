"use client";

import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * The width of a chart container. It changes when the container changes
 * size. The height is a prop of each chart, so the layout does not move
 * while data loads.
 */
export function useChartSize<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    // jsdom and very old browsers have no ResizeObserver. The first width stays.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
