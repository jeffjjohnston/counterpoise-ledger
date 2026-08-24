import type { z } from "zod/v4";

export type ToolShapeOptions = {
  /**
   * Where the dropped object-level rule is enforced instead, written as
   * "<file>:<function>". Required to spread a schema that carries one.
   */
  objectRefineHandledBy?: string;
};

/**
 * A shared schema's `.shape`, for spreading into a tool's `inputSchema`.
 *
 * Spreading keeps every field-level rule and silently drops anything attached
 * to the object itself — `z.object({...}).refine(...)` and `.superRefine(...)`.
 * The tool then accepts input the HTTP route rejects, and the difference shows
 * up as a database error or a malformed write rather than a validation
 * message. This throws at registration time instead, so `registerAllTools`
 * fails and every existing suite that builds a server catches it. There is no
 * new test to remember to write.
 *
 * Pass `objectRefineHandledBy` when the shared library the tool calls enforces
 * the same rule — as `lib/issue-reports.ts`'s `updateIssueReport` does for
 * `updateIssueReportSchema`'s "at least one field" refinement.
 */
export function toolShape<T extends z.ZodObject>(
  schema: T,
  opts: ToolShapeOptions = {}
): T["shape"] {
  // zod v4 keeps object-level rules in _zod.def.checks. A plain object has no
  // `checks` key at all — undefined, NOT an empty array (measured) — and both
  // .refine() and .superRefine() give it length 1, which is why this counts
  // rather than testing for a particular method.
  const checkCount =
    (schema as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks
      ?.length ?? 0;

  if (checkCount > 0 && !opts.objectRefineHandledBy) {
    throw new Error(
      "toolShape(): this schema carries an object-level .refine()/.superRefine() that " +
        "spreading .shape would silently drop, so the tool would accept input the HTTP " +
        "route rejects. Enforce the same rule in the shared library the tool calls, then " +
        'pass { objectRefineHandledBy: "<file>:<function>" } to record where.'
    );
  }

  return schema.shape;
}
