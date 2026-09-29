type Picks = Partial<Record<"match" | "payee" | "category", string>>;

/**
 * A valid TypeSafe reply for every question in the request that `init` sent.
 * Tests use it instead of a live call. The reply puts all probability on one
 * option per question, so the client accepts it.
 */
export function typesafeReply(init: RequestInit | undefined, picks: Picks = {}) {
  const body = JSON.parse(String(init?.body)) as {
    questions: Record<string, { criteria: Record<string, unknown> }>;
  };
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, question]) => {
      const labels = Object.keys(question.criteria);
      const wanted = picks[id as keyof Picks];
      const choice =
        wanted === undefined
          ? (labels.find((label) => label !== "none") ?? "none")
          : labels.includes(wanted)
            ? wanted
            : labels.find((label) =>
                JSON.stringify(question.criteria[label]).includes(wanted),
              );
      if (!choice) throw new Error(`No option matches ${wanted} in ${id}`);
      return [
        id,
        {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(
            labels.map((label) => [label, label === choice ? 1 : 0]),
          ),
          confidence: 1,
        },
      ];
    }),
  );
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 100, output_tokens: 3 },
    }),
  );
}
