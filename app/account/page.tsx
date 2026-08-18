"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ApiKeyManager } from "@/components/account/ApiKeyManager";
import { apiGet, apiPut, toMessage } from "@/lib/api-client";

type User = {
  id: number;
  username: string;
};

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const loadUser = async () => {
      try {
        const data = await apiGet<User>("/api/auth/me");
        setUser(data);
      } catch (err) {
        setError(toMessage(err, "Failed to load account"));
      } finally {
        setIsLoadingUser(false);
      }
    };

    // loadUser handles its own errors internally.
    void loadUser();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("All password fields are required");
      return;
    }

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match");
      return;
    }

    setIsSaving(true);
    try {
      await apiPut("/api/auth/password", { currentPassword, newPassword });

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Password updated successfully");
    } catch (err) {
      setError(toMessage(err, "Failed to update password"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-secondary">
      <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-6">
          <Link href="/" className="text-sm text-fg-accent hover:text-fg-accent font-medium">
            Back to books
          </Link>
        </div>

        <div className="bg-surface rounded-lg border border-border shadow-soft p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-fg">Account</h1>
          <p className="text-sm text-fg-tertiary mt-1">
            {isLoadingUser ? "Loading..." : `Signed in as ${user?.username ?? "Unknown user"}`}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4 mt-6">
            {error && (
              <div className="bg-danger-subtle border border-border text-fg-danger px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}
            {success && (
              <div className="bg-success-subtle border border-border text-fg-success px-4 py-3 rounded-lg text-sm">
                {success}
              </div>
            )}

            <Input
              id="current-password"
              label="Current password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />

            <Input
              id="new-password"
              label="New password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            <Input
              id="confirm-password"
              label="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            <Button type="submit" disabled={isSaving} className="w-full">
              {isSaving ? "Updating..." : "Change password"}
            </Button>
          </form>
        </div>

        <div className="bg-surface rounded-lg border border-border shadow-soft p-6 sm:p-8 mt-6">
          <h2 className="text-xl font-bold text-fg">API Keys</h2>
          <p className="text-sm text-fg-tertiary mt-1">
            Create API keys to allow MCP clients (like Claude Desktop) to read and write data in your books.
          </p>
          <div className="mt-4">
            <ApiKeyManager />
          </div>
        </div>
      </div>
    </div>
  );
}
