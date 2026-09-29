import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "@/lib/typesafe/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const questions = {
  match: {
    instructions: "Which candidate?",
    criteria: { candidate_1: "The first candidate.", none: "No candidate." },
  },
  category: {
    instructions: "Which category?",
    criteria: { category_1: { account: "Dining" }, none: "None fits." },
  },
};
const answer = {
  model: "jev-1.13.0",
  answers: {
    match: {
      type: "choice",
      choice: "candidate_1",
      probabilities: { candidate_1: 0.8, none: 0.2 },
      confidence: 0.4,
    },
    category: {
      type: "choice",
      choice: "category_1",
      probabilities: { category_1: 0.7, none: 0.3 },
      confidence: 0.3,
    },
  },
  usage: { input_tokens: 120, output_tokens: 10 },
};
function enable() {
  vi.stubEnv("TYPESAFE_ENABLED", "true");
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
}

describe("TypeSafe transport", () => {
  it("sends every question as a pinned Choice and returns each answer", async () => {
    enable();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(answer)));
    vi.stubGlobal("fetch", fetcher);
    const result = await evaluate({ merchant: "Blue Bottle" }, questions);
    expect(result.answers).toEqual({
      match: {
        choice: "candidate_1",
        probabilities: { candidate_1: 0.8, none: 0.2 },
        confidence: 0.4,
      },
      category: {
        choice: "category_1",
        probabilities: { category_1: 0.7, none: 0.3 },
        confidence: 0.3,
      },
    });
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 10 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(init.body)).toEqual({
      model: "jev-1.13.0",
      state: { merchant: "Blue Bottle" },
      questions: {
        match: { type: "choice", ...questions.match },
        category: { type: "choice", ...questions.category },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when globally disabled even if a key is present", async () => {
    vi.stubEnv("TYPESAFE_ENABLED", "false");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(evaluate({}, questions)).rejects.toThrow("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { choice: "invented" },
    { probabilities: { category_1: 1, none: 1 } },
    { probabilities: { category_1: 1 } },
    { probabilities: { category_1: 0.7, none: 0.3, invented: 0 } },
    { choice: "none" },
    { confidence: 2 },
  ])(
    "rejects the whole response when one answer is malformed: %j",
    async (change) => {
      enable();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              ...answer,
              answers: {
                ...answer.answers,
                category: { ...answer.answers.category, ...change },
              },
            }),
          ),
        ),
      );
      await expect(evaluate({}, questions)).rejects.toThrow(
        "invalid_response",
      );
    },
  );

  it("rejects a response that leaves out an asked question", async () => {
    enable();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...answer,
            answers: { match: answer.answers.match },
          }),
        ),
      ),
    );
    await expect(evaluate({}, questions)).rejects.toThrow("invalid_response");
  });

  it("does not retry or expose the provider error body", async () => {
    enable();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("secret merchant data", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(evaluate({}, questions)).rejects.toThrow("rate_limited");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts after the bounded deadline with a sanitized timeout", async () => {
    enable();
    const controller = new AbortController();
    const deadline = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("sensitive transport error")),
            );
          }),
      ),
    );
    const pending = evaluate({}, questions);
    const assertion = expect(pending).rejects.toThrow("timeout");
    controller.abort();
    await assertion;
    expect(deadline).toHaveBeenCalledWith(5000);
  });
});
