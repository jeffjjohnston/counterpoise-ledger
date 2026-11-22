"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ApiKeyManager } from "@/components/account/ApiKeyManager";
import { ConnectedApps } from "@/components/account/ConnectedApps";
import { ChangeUsernameForm } from "@/components/account/ChangeUsernameForm";
import { apiGet, apiPut, toMessage } from "@/lib/api-client";

type User = {
  id: number;
  username: string;
};

/** The Account group of the settings page. It applies to all the user's books. */
export function AccountSettings() {
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
    <>
      <section id="account" className="scroll-mt-24 space-y-3">
        <h3 className="text-base font-semibold text-fg">Profile</h3>
        <p className="text-sm text-fg-tertiary">
          {isLoadingUser ? "Loading..." : `Signed in as ${user?.username ?? "Unknown user"}`}
        </p>
        <p className="text-sm text-fg-tertiary">
          Change the name that you sign in with. You stay signed in, and your API keys and
          connected apps continue to work.
        </p>
        <ChangeUsernameForm currentUsername={user?.username ?? null} onChanged={setUser} />
      </section>

      <section id="security" className="scroll-mt-24 pt-6 border-t border-border">
        <h3 className="text-base font-semibold text-fg">Password</h3>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
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

            <Button type="submit" disabled={isSaving} className="w-full sm:w-auto">
              {isSaving ? "Updating..." : "Change password"}
            </Button>
          </form>
      </section>

      <section id="api-keys" className="scroll-mt-24 pt-6 border-t border-border">
        <h3 className="text-base font-semibold text-fg">API keys</h3>
        <p className="text-sm text-fg-tertiary mt-1">
          Create API keys to allow MCP clients (like Claude Desktop) to read and write data in your books.
        </p>
        <div className="mt-4">
          <ApiKeyManager />
        </div>
      </section>

      <section id="connected-apps" className="scroll-mt-24 pt-6 border-t border-border">
        <h3 className="text-base font-semibold text-fg">Connected apps</h3>
        <p className="text-sm text-fg-tertiary mt-1">
          Apps that you connected with a sign-in, such as a Claude custom connector. Disconnect an
          app to stop its access at once.
        </p>
        <div className="mt-4">
          <ConnectedApps />
        </div>
      </section>
    </>
  );
}
