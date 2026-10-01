"use client";

import { useState, type FormEvent } from "react";
import styles from "./join.module.css";

export function AccessForm({
  token,
  purpose,
  displayName,
  login,
}: {
  token: string;
  purpose: "invite" | "password_reset";
  displayName: string;
  login: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (password !== confirmation) {
      setError("The two password entries do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? "This access link could not be completed.");
        return;
      }
      window.location.assign("/");
    } catch {
      setError("Hot Potato could not reach the operator workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.identity}>
        <span>
          {purpose === "invite" ? "JOINING AS" : "RESETTING ACCESS FOR"}
        </span>
        <strong>{displayName}</strong>
        <small>{login}</small>
      </div>
      <label>
        New password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={1024}
          autoFocus
        />
        <small>Use at least 12 characters.</small>
      </label>
      <label>
        Confirm password
        <input
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={1024}
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        <span>
          {busy
            ? "Securing access…"
            : purpose === "invite"
              ? "Join workspace"
              : "Reset and sign in"}
        </span>
        <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}
