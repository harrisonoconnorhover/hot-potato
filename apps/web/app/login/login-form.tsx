"use client";

import { useState, type FormEvent } from "react";
import styles from "./login.module.css";

export function safeNextPath(candidate: string | null, origin: string): string {
  if (!candidate?.startsWith("/")) return "/";
  try {
    const resolved = new URL(candidate, origin);
    return resolved.origin === origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function LoginForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: form.get("login"),
          password: form.get("password"),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? "Hot Potato could not sign you in.");
        return;
      }
      window.location.assign(
        safeNextPath(
          new URLSearchParams(window.location.search).get("next"),
          window.location.origin,
        ),
      );
    } catch {
      setError("Hot Potato could not reach the operator workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label>
        Login
        <input
          name="login"
          autoComplete="username"
          required
          minLength={3}
          maxLength={254}
          autoFocus
        />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        <span>{busy ? "Signing in…" : "Enter workspace"}</span>
        <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}
