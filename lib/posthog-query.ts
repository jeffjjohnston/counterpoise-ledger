/**
 * PostHog Query API client (HogQL).
 *
 * The legacy /api/event/ endpoint is deprecated and silently returns only the
 * most recent events regardless of the requested window. All historical
 * analysis must go through POST /api/projects/@current/query/ with a HogQL
 * query. The @current alias is required because project-scoped personal API
 * keys cannot list projects.
 */

export interface PostHogQueryResult {
  columns: string[];
  results: unknown[][];
}

export function getPostHogQueryConfig(): { host: string; apiKey: string } | null {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!apiKey || !host) return null;
  return { host, apiKey };
}

export function escapeHogQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** HogQL returns the events.properties column as a JSON string. */
export function parsePropertiesColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function runHogQLQuery(query: string): Promise<PostHogQueryResult> {
  const config = getPostHogQueryConfig();
  if (!config) {
    throw new Error(
      "PostHog not configured (POSTHOG_PERSONAL_API_KEY, NEXT_PUBLIC_POSTHOG_HOST)"
    );
  }

  const res = await fetch(`${config.host}/api/projects/@current/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const bodySnippet = body ? ` ${body.slice(0, 500)}` : "";
    throw new Error(
      `PostHog API error: ${res.status} ${res.statusText}${bodySnippet}`
    );
  }

  const data = (await res.json()) as {
    columns?: string[];
    results?: unknown[][];
  };

  return { columns: data.columns ?? [], results: data.results ?? [] };
}
