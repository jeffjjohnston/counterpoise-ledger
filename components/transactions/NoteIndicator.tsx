"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface NoteIndicatorProps {
  notes: string;
}

export function NoteIndicator({ notes }: NoteIndicatorProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={(e) => e.stopPropagation()}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4 text-fg-tertiary hover:text-fg-secondary transition-colors flex-shrink-0"
        aria-label="Has notes"
      >
        <path
          fillRule="evenodd"
          d="M4.5 2A1.5 1.5 0 003 3.5v13A1.5 1.5 0 004.5 18h11a1.5 1.5 0 001.5-1.5V7.621a1.5 1.5 0 00-.44-1.06l-4.12-4.122A1.5 1.5 0 0011.378 2H4.5zm2.25 8.5a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 3a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"
          clipRule="evenodd"
        />
      </svg>
      {showTooltip && (
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50 w-64 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg p-3 text-sm text-fg prose prose-sm dark:prose-invert max-w-none"
          onClick={(e) => e.stopPropagation()}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
          <div className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 rotate-45 border-r border-b border-border bg-surface" />
        </div>
      )}
    </span>
  );
}
