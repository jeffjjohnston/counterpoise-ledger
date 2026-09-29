"use client";

import { useParams } from "@/lib/navigation";

export function useBookId(): string {
  const params = useParams();
  return params.bookId as string;
}
