import type { z } from "zod/v4";

export type ToolShapeOptions<T extends z.ZodObject> = {
  /**
   * Where the dropped object-level rule is enforced instead, written as
   * "<file>:<function>". Required to spread a schema that carries one.
   */
  objectRefineHandledBy?: string;
  /**
   * Fields to leave out of the published shape, e.g. a credential a tool must
   * not accept. Applied here rather than by the caller so the guard always
   * inspects the original schema. Zod 4.5 rejects omit/pick/partial on refined
   * objects, but spreading .shape still drops object-level rules.
   */
  omit?: { [K in keyof T["shape"]]?: true };
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
 *
 * Pass `omit` to drop fields, never `.omit()` at the call site — see the
 * option's own comment for why the difference matters.
 */
export function toolShape<T extends z.ZodObject>(
  schema: T,
  opts?: ToolShapeOptions<T> & { omit?: undefined }
): T["shape"];
export function toolShape<T extends z.ZodObject, K extends keyof T["shape"] & string>(
  schema: T,
  opts: ToolShapeOptions<T> & { omit: { [P in K]: true } }
): Omit<T["shape"], K>;
// The overloads above are what keep the return type exact. A single signature
// returning Partial<T["shape"]> compiles here and then widens every spread
// field to optional at all 20 call sites — the SDK infers each handler's
// argument type straight from inputSchema, so the looser shape propagates into
// the handler signature and breaks the calls into lib/. tsc reports it, but at
// the call sites rather than here.
export function toolShape<T extends z.ZodObject>(
  schema: T,
  opts: { objectRefineHandledBy?: string; omit?: Record<string, true> } = {}
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

  // Checked first, deliberately: reversing these two lines is the obvious
  // simplification and it reinstates the exact hole this function closes.
  if (!opts.omit) return schema.shape;

  const dropped = new Set(Object.keys(opts.omit));
  return Object.fromEntries(
    Object.entries(schema.shape).filter(([key]) => !dropped.has(key))
  ) as T["shape"];
}
