"use client";

import { useSearchParams } from "@/lib/navigation";
import { ConsentForm } from "./ConsentForm";

/**
 * The OAuth consent page for MCP clients. The page gate lets only a browser
 * with a session reach it. The query is the authorization request; the
 * server reads it again for each call, so the page keeps no copy of its own.
 */
export default function ConsentPage() {
  return <ConsentForm query={useSearchParams().toString()} />;
}
