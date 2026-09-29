import { z } from "zod/v4";
import type { ChoiceAnswer } from "./types";

// Direct HTTP contract: https://docs.typesafe.ai/api. Keep this module server-only
// by importing it exclusively from server services/routes, never client components.
export const TYPESAFE_MODEL = "jev-1.13.0";
export const MATCH_PROMPT_VERSION = "plaid-match-v3";

export function isTypeSafeConfigured() {
  return (
    process.env.TYPESAFE_ENABLED === "true" &&
    !!process.env.TYPESAFE_API_KEY?.trim()
  );
}

export class TypeSafeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TypeSafeError";
  }
}

export type ChoiceQuestion = {
  instructions: unknown;
  criteria: Record<string, unknown>;
};

const probability = z.number().finite().min(0).max(1);
const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability,
});
const responseSchema = z.object({
  model: z.literal(TYPESAFE_MODEL),
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

// An answer is usable only when its distribution covers exactly the asked
// options, sums to 1, and its choice is the most probable option.
function consistent(answer: ChoiceAnswer, criteria: Record<string, unknown>) {
  const expected = Object.keys(criteria);
  const values = Object.values(answer.probabilities);
  return (
    Object.keys(answer.probabilities).length === expected.length &&
    expected.every((key) => Object.hasOwn(answer.probabilities, key)) &&
    Object.hasOwn(criteria, answer.choice) &&
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 0.001 &&
    answer.probabilities[answer.choice] >= Math.max(...values)
  );
}

/**
 * Asks all the Choice questions in one request. They run in parallel on the
 * same state. If one answer is missing or not consistent, the whole response
 * is rejected, because code must not act on a part of a bad response.
 */
export async function evaluate(
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
) {
  if (!isTypeSafeConfigured()) throw new TypeSafeError("unavailable");
  const signal = AbortSignal.timeout(5000);
  try {
    // TYPESAFE_API_URL replaces the origin. The HTTP parity tests point it at
    // a local mock, so no test calls TypeSafe.
    const origin = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai";
    const response = await fetch(`${origin}/v1/systemone`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY!.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            { type: "choice", ...question },
          ]),
        ),
      }),
    });
    if (!response.ok)
      throw new TypeSafeError(
        response.status === 429 ? "rate_limited" : "provider_error",
      );
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new TypeSafeError("invalid_response");
    const answers: Record<string, ChoiceAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = parsed.data.answers[id];
      if (!answer || !consistent(answer, question.criteria))
        throw new TypeSafeError("invalid_response");
      answers[id] = {
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    }
    return {
      answers,
      model: parsed.data.model,
      usage: parsed.data.usage ?? null,
    };
  } catch (error) {
    if (error instanceof TypeSafeError) throw error;
    throw new TypeSafeError(
      signal.aborted
        ? "timeout"
        : error instanceof SyntaxError
          ? "invalid_response"
          : "network_error",
    );
  }
}
