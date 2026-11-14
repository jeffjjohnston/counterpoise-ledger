"use client";

import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { apiPut, toMessage } from "@/lib/api-client";

type User = {
  id: number;
  username: string;
};

type Props = {
  currentUsername: string | null;
  onChanged: (user: User) => void;
};

/**
 * Changes the username of the signed-in user. The server needs the current
 * password. The session stays valid, so the user stays signed in.
 */
export function ChangeUsernameForm({ currentUsername, onChanged }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!username || !password) {
      setError("New username and password are required");
      return;
    }

    if (username.length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }

    if (username === currentUsername) {
      setError("New username must be different from current username");
      return;
    }

    setIsSaving(true);
    try {
      const user = await apiPut<User>("/api/auth/username", {
        username,
        currentPassword: password,
      });
      setUsername("");
      setPassword("");
      setSuccess(`Username changed to ${user.username}`);
      onChanged(user);
    } catch (err) {
      setError(toMessage(err, "Failed to update username"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
        id="new-username"
        label="New username"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        minLength={3}
        required
      />

      <Input
        id="username-password"
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
      />

      <Button type="submit" disabled={isSaving} className="w-full">
        {isSaving ? "Updating..." : "Change username"}
      </Button>
    </form>
  );
}
