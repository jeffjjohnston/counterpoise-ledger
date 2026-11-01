import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { subscribeTypeSafeSettings } from "@/lib/typesafe/events";
import type { EntryPattern, EntrySuggestion, TypeSafeSettings } from "@/lib/typesafe/types";

type Input = {
  bookId: string;
  accountId: number | null;
  payeeId: number | null;
  date: string;
  /** The amount in cents that the user typed before the payee, read when the request is sent. */
  typedAmount: () => number | null;
  active: boolean;
};

export type EntryPick = { key: string; source: "history" | "typesafe" };

/**
 * The wait before the TypeSafe request. A payee typed past (an exact match on
 * the way to a longer name) or a date changed in the meantime makes no call
 * and spends no quota.
 */
export const SUGGESTION_DELAY_MS = 400;

/**
 * The patterns of the payee in the account, and the pick: the newest
 * pattern at once, then the TypeSafe choice for an opted-in book. An answer
 * for other inputs is dropped. See guides/typesafe-experiment.md.
 */
export function useEntrySuggestion({ bookId, accountId, payeeId, date, typedAmount, active }: Input) {
  const [patterns, setPatterns] = useState<EntryPattern[] | null>(null);
  const [pick, setPick] = useState<EntryPick | null>(null);
  const [unsure, setUnsure] = useState(false);
  const [evaluationId, setEvaluationId] = useState<number | null>(null);
  const [entryEnabled, setEntryEnabled] = useState(false);
  // The settings revision fences answers, as on the server: a settings change
  // drops an answer that was asked for before it.
  const [revision, setRevision] = useState<number | null>(null);
  const typed = useRef(typedAmount);
  const inputs = `${bookId}|${accountId}|${payeeId}|${date}|${active}|${revision}`;
  const current = useRef(inputs);

  useEffect(() => {
    typed.current = typedAmount;
  }, [typedAmount]);

  useEffect(() => {
    let live = true;
    const load = () => {
      apiGet<TypeSafeSettings>(`/api/b/${bookId}/settings/typesafe`, { cache: "no-store" })
        .then((value) => {
          if (!live) return;
          setEntryEnabled(value.configured && value.entrySuggestionsEnabled);
          setRevision(value.revision);
        })
        .catch(() => {
          if (live) setEntryEnabled(false);
        });
    };
    load();
    const unsubscribe = subscribeTypeSafeSettings(bookId, load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bookId]);

  useEffect(() => {
    current.current = inputs;
    setPatterns(null);
    setPick(null);
    setUnsure(false);
    setEvaluationId(null);
    if (!active || accountId === null || payeeId === null) return;
    const controller = new AbortController();
    const fresh = () => current.current === inputs && !controller.signal.aborted;
    void (async () => {
      let loaded: EntryPattern[];
      try {
        const answer = await apiGet<{ patterns?: unknown }>(
          `/api/b/${bookId}/payees/${payeeId}/entry-patterns?accountId=${accountId}`,
          { signal: controller.signal },
        );
        loaded = Array.isArray(answer?.patterns) ? (answer.patterns as EntryPattern[]) : [];
      } catch {
        // No patterns: the form falls back to the fill that it had before.
        loaded = [];
      }
      if (!fresh()) return;
      setPatterns(loaded);
      try {
        if (loaded.length === 0) return;
        setPick({ key: loaded[0].key, source: "history" });
        if (!entryEnabled || loaded.length < 2) return;
        await new Promise((resolve) => setTimeout(resolve, SUGGESTION_DELAY_MS));
        if (!fresh()) return;
        const answer = await apiPost<EntrySuggestion>(`/api/b/${bookId}/entry-suggestion`, {
          accountId,
          payeeId,
          date,
          amount: typed.current(),
        });
        if (!fresh()) return;
        if ("evaluationId" in answer) setEvaluationId(answer.evaluationId);
        if (answer.status !== "ready") return;
        if (answer.choice === null) setUnsure(true);
        else if (loaded.some((pattern) => pattern.key === answer.choice)) {
          setPick({ key: answer.choice, source: "typesafe" });
        }
      } catch {
        // The fill is a help: a failure leaves the form as it is.
      }
    })();
    return () => controller.abort();
  }, [bookId, accountId, payeeId, date, active, entryEnabled, revision, inputs]);

  return { patterns, pick, unsure, evaluationId, entryEnabled };
}
