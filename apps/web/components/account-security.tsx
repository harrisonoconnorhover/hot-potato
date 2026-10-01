"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "./account-security.module.css";

type Session = {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
};

type SessionResponse = {
  sessions: Session[];
  currentSessionId: string;
  error?: string;
};

function sessionLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const browser = userAgent.includes("Edg/")
    ? "Edge"
    : userAgent.includes("Firefox/")
      ? "Firefox"
      : userAgent.includes("Chrome/")
        ? "Chrome"
        : userAgent.includes("Safari/")
          ? "Safari"
          : "Browser";
  const platform =
    userAgent.includes("iPhone") || userAgent.includes("iPad")
      ? "iOS"
      : userAgent.includes("Android")
        ? "Android"
        : userAgent.includes("Mac OS") || userAgent.includes("Macintosh")
          ? "macOS"
          : userAgent.includes("Windows")
            ? "Windows"
            : userAgent.includes("Linux")
              ? "Linux"
              : "unknown device";
  return `${browser} on ${platform}`;
}

function formatSessionDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AccountSecurity({
  displayName,
  login,
}: {
  displayName: string;
  login: string;
}) {
  const [data, setData] = useState<SessionResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/auth/sessions", { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as SessionResponse;
    if (!response.ok) {
      throw new Error(body.error ?? "Active sessions could not be loaded.");
    }
    setData(body);
  }, []);

  useEffect(() => {
    load().catch((error: unknown) =>
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Active sessions could not be loaded.",
      }),
    );
  }, [load]);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmation = String(formData.get("confirmation") ?? "");
    if (newPassword !== confirmation) {
      setNotice({ tone: "error", message: "The new passwords do not match." });
      return;
    }
    setBusy("password");
    setNotice(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "The password could not be changed.");
      }
      form.reset();
      setNotice({
        tone: "success",
        message:
          "Password changed. Every other active session has been revoked.",
      });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Password change failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(session: Session) {
    setBusy(session.sessionId);
    setNotice(null);
    try {
      const response = await fetch(`/api/auth/sessions/${session.sessionId}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "The session could not be revoked.");
      }
      setNotice({
        tone: "success",
        message: "The other session is signed out.",
      });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Session update failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={styles.shell}
      id="personal-security"
      aria-labelledby="personal-security-heading"
    >
      <header>
        <div>
          <span>PERSONAL SECURITY</span>
          <h2 id="personal-security-heading">Your password. Your sessions.</h2>
          <p>
            {displayName} · {login}
          </p>
        </div>
        <strong>{data?.sessions.length ?? "—"} active</strong>
      </header>

      {notice && (
        <p className={`${styles.notice} ${styles[notice.tone]}`} role="status">
          {notice.message}
        </p>
      )}

      <div className={styles.grid}>
        <form onSubmit={changePassword}>
          <div>
            <span>CHANGE PASSWORD</span>
            <p>Changing it signs out every browser except this one.</p>
          </div>
          <label>
            Current password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </label>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
            />
          </label>
          <label>
            Confirm new password
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
            />
          </label>
          <button type="submit" disabled={busy !== null}>
            {busy === "password" ? "Changing…" : "Change password"}
          </button>
        </form>

        <div className={styles.sessions}>
          <div>
            <span>ACTIVE SESSIONS</span>
            <p>End any browser you no longer recognize.</p>
          </div>
          <ul>
            {data?.sessions.map((session) => {
              const current = session.sessionId === data.currentSessionId;
              return (
                <li key={session.sessionId}>
                  <div className={styles.deviceMark} aria-hidden="true">
                    {current ? "●" : "○"}
                  </div>
                  <div>
                    <strong>{sessionLabel(session.userAgent)}</strong>
                    <small>
                      {current
                        ? "This browser"
                        : `Last used ${formatSessionDate(session.lastSeenAt)}`}
                    </small>
                    <small>
                      Expires {formatSessionDate(session.expiresAt)}
                    </small>
                  </div>
                  {current ? (
                    <span>CURRENT</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === session.sessionId}
                      onClick={() => void revoke(session)}
                    >
                      {busy === session.sessionId ? "Ending…" : "End session"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
