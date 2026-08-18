"use client";

import { useParams } from "next/navigation";

export function useBookId(): string {
  const params = useParams();
  return params.bookId as string;
}
