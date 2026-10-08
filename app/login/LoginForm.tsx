"use client";

import { useEffect, useState } from "react";
import { Link, useRouter, useSearchParams } from "@/lib/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { identifyUser } from "@/lib/posthog-client";
import { apiPost, toMessage } from "@/lib/api-client";
import { useRegistrationOpen } from "@/hooks/useRegistrationOpen";

/**
 * The page to open after login. Only the OAuth consent page may be named:
 * `/api/oauth/authorize` sends a browser without a session here with
 * `next=/oauth/consent?...`. Any other value goes to the books page, so
 * `next` cannot send a user to another site.
 */
export function returnPath(next: string | null): string {
  if (next !== null && /^\/oauth\/consent(?:\?|$)/.test(next)) return next;
  return "/";
}

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const registrationOpen = useRegistrationOpen();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await apiPost<{ id: number }>("/api/auth/login", { username, password });
      identifyUser(data.id);
      router.push(returnPath(next));
    } catch (err) {
      setError(toMessage(err, "An error occurred. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="w-full max-w-md px-4">
        <div
          className="bg-surface rounded-xl shadow-soft border border-border p-8"
          data-testid={hydrated ? "login-ready" : undefined}
        >
          <div className="text-center mb-8">
            <div
              className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-soft"
              role="img"
              aria-label="Counterpoise"
            >
              <span className="text-2xl font-bold text-fg-on-accent" aria-hidden="true">
                C
              </span>
            </div>
            <h1 className="text-2xl font-bold text-fg">Counterpoise</h1>
            <p className="text-fg-tertiary mt-1 text-sm">Personal finance, simply tracked</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-danger-subtle text-fg-danger px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <Input
              id="username"
              label="Username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
            />

            <Input
              id="password"
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            <Button type="submit" disabled={!hydrated || loading} className="w-full" size="lg">
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          {registrationOpen === true && (
            <p className="text-center text-sm text-fg-tertiary mt-6">
              Don&apos;t have an account?{" "}
              <Link href="/register" className="text-fg-accent hover:underline font-medium">
                Register
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
