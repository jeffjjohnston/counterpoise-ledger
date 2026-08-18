import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Select an input's full contents. Per the HTML spec, select() throws
 * InvalidStateError for input types that don't support selection, so swallow
 * it to keep focus handling safe for any input type.
 */
export function selectInputContents(input: HTMLInputElement): void {
  try {
    input.select();
  } catch (error) {
    // Selection not supported for this input type — nothing to do.
    if (!(error instanceof DOMException) || error.name !== "InvalidStateError") {
      throw error;
    }
  }
}
