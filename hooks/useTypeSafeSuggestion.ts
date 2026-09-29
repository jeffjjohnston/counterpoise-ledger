"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiGet, apiPost } from "@/lib/api-client";
import { subscribeTypeSafeSettings } from "@/lib/typesafe/events";
import type { MatchSuggestion, TypeSafeSettings } from "@/lib/typesafe/types";

export function useTypeSafeSuggestion(
  bookId: string,
  linkId: number | null,
  rowId: number | null,
  active: boolean,
) {
  const key = `${bookId}:${linkId}:${rowId}:${active}`;
  const [state, setState] = useState<{
    key: string;
    result: MatchSuggestion | null;
    loading: boolean;
  }>({ key: "", result: null, loading: false });
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const review = useRef({ key, elapsed: 0, since: 0 });
  const result = state.key === key ? state.result : null;
  const url = `/api/b/${bookId}/sync/accounts/${linkId}/reconcile/suggestion`;
  const refresh = useCallback(() => {
    generation.current++;
    setState({ key: "", result: null, loading: false });
    setVersion((n) => n + 1);
  }, []);

  useEffect(() => {
    review.current = {
      key,
      elapsed: 0,
      since: document.visibilityState === "hidden" ? 0 : Date.now(),
    };
  }, [key]);
  useEffect(() => {
    const unsubscribe = subscribeTypeSafeSettings(bookId, refresh);
    const visibility = () => {
      const clock = review.current;
      if (clock.since) clock.elapsed += Date.now() - clock.since;
      clock.since = document.visibilityState === "hidden" ? 0 : Date.now();
      refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [bookId, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const ownGeneration = ++generation.current;
    if (
      !active ||
      rowId === null ||
      linkId === null ||
      document.visibilityState === "hidden"
    )
      return;
    async function load() {
      try {
        const settingsUrl = `/api/b/${bookId}/settings/typesafe`;
        const settings = await apiGet<TypeSafeSettings>(settingsUrl, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (
          !settings.enabled ||
          !settings.configured ||
          generation.current !== ownGeneration
        )
          return;
        setState({ key, result: null, loading: true });
        const answer = await apiPost<MatchSuggestion>(
          url,
          { reconciliationId: rowId },
          { signal: controller.signal },
        );
        const latest = await apiGet<TypeSafeSettings>(settingsUrl, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted || generation.current !== ownGeneration)
          return;
        if (
          !latest.enabled ||
          !latest.configured ||
          latest.revision !== settings.revision ||
          (answer.status === "ready" && answer.revision !== latest.revision)
        ) {
          setState({ key, result: null, loading: false });
          return;
        }
        setState({ key, result: answer, loading: false });
      } catch {
        if (!controller.signal.aborted && generation.current === ownGeneration)
          setState({ key, result: { status: "unavailable" }, loading: false });
      }
    }
    void load();
    return () => controller.abort();
  }, [active, rowId, linkId, bookId, key, url, version]);

  // This runs after the suggestion is rendered, not simply when HTTP completes.
  useEffect(() => {
    if (result?.status !== "ready" || document.visibilityState === "hidden")
      return;
    const controller = new AbortController();
    void apiFetch(url, {
      method: "PATCH",
      body: { evaluationId: result.evaluationId },
      signal: controller.signal,
    }).catch(() => {
      if (!controller.signal.aborted)
        setState({ key, result: { status: "stale" }, loading: false });
    });
    return () => controller.abort();
  }, [result, url, key]);

  const observation = useCallback(() => {
    const clock = review.current;
    return {
      evaluationId: result?.evaluationId,
      suggestionVisible: result?.status === "ready",
      activeReviewMs: Math.min(
        3_600_000,
        clock.key === key
          ? clock.elapsed + (clock.since ? Date.now() - clock.since : 0)
          : 0,
      ),
    };
  }, [key, result]);
  return {
    result,
    loading: state.key === key && state.loading,
    refresh,
    observation,
  };
}
