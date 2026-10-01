"use client";

import type { DashboardRep } from "@hot-potato/db";
import { useCallback, useEffect, useMemo, useState } from "react";

type EmailToolKey = {
  id: string;
  organizationSlug: string;
  repId: string;
  clientType: "gmail" | "outlook";
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  outlookIdentityLinked: boolean;
};

function shortDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function EmailToolsSettings({ reps }: { reps: DashboardRep[] }) {
  const activeReps = useMemo(() => reps.filter((rep) => rep.active), [reps]);
  const [repId, setRepId] = useState(activeReps[0]?.id ?? "");
  const [keys, setKeys] = useState<EmailToolKey[]>([]);
  const [gmailConfigured, setGmailConfigured] = useState(false);
  const [outlookNaaConfigured, setOutlookNaaConfigured] = useState(false);
  const [outlookNaaConfigurationError, setOutlookNaaConfigurationError] =
    useState(false);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRep = activeReps.find((rep) => rep.id === repId);

  const loadKeys = useCallback(async (selectedRepId: string) => {
    if (!selectedRepId) return;
    const query = new URLSearchParams({ repId: selectedRepId });
    const response = await fetch(`/api/settings/email-tools/keys?${query}`, {
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as {
      keys?: EmailToolKey[];
      gmailConfigured?: boolean;
      outlookNaaConfigured?: boolean;
      outlookNaaConfigurationError?: boolean;
      error?: string;
    };
    if (!response.ok || !body.keys) {
      throw new Error(body.error ?? "Email tools could not be loaded.");
    }
    setKeys(body.keys);
    setGmailConfigured(Boolean(body.gmailConfigured));
    setOutlookNaaConfigured(Boolean(body.outlookNaaConfigured));
    setOutlookNaaConfigurationError(Boolean(body.outlookNaaConfigurationError));
  }, []);

  useEffect(() => {
    if (!repId && activeReps[0]) setRepId(activeReps[0].id);
  }, [activeReps, repId]);

  useEffect(() => {
    setNewToken(null);
    setCopied(false);
    setError(null);
    const rep = activeReps.find((candidate) => candidate.id === repId);
    setLabel(rep ? `${rep.name} · Outlook` : "Outlook");
    loadKeys(repId).catch((caught: unknown) =>
      setError(
        caught instanceof Error
          ? caught.message
          : "Email tools could not be loaded.",
      ),
    );
  }, [activeReps, loadKeys, repId]);

  async function createKey() {
    if (!repId) return;
    setBusy(true);
    setNewToken(null);
    setCopied(false);
    setError(null);
    try {
      const response = await fetch("/api/settings/email-tools/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repId, clientType: "outlook", label }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        key?: EmailToolKey;
        token?: string;
        error?: string;
      };
      if (!response.ok || !body.key || !body.token) {
        throw new Error(body.error ?? "The Outlook key could not be created.");
      }
      setNewToken(body.token);
      setKeys((current) => [body.key!, ...current]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The Outlook key could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the key and copy it manually.");
    }
  }

  async function revoke(key: EmailToolKey) {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ repId: key.repId });
      const response = await fetch(
        `/api/settings/email-tools/keys/${encodeURIComponent(key.id)}?${query}`,
        { method: "DELETE" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        key?: EmailToolKey;
        error?: string;
      };
      if (!response.ok || !body.key) {
        throw new Error(body.error ?? "The key could not be revoked.");
      }
      setKeys((current) =>
        current.map((candidate) =>
          candidate.id === body.key!.id ? body.key! : candidate,
        ),
      );
      setNewToken(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The key could not be revoked.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="email-tools-card" id="email-tools">
      <div className="card-heading">
        <div>
          <span className="section-number">11</span>
          <div>
            <h2>Email scheduling</h2>
            <p>
              Insert Smart Router Links or live times without leaving the draft.
            </p>
          </div>
        </div>
        <span className="live-pill">
          <i /> GMAIL + OUTLOOK
        </span>
      </div>

      <div className="email-tools-intro">
        <div>
          <span>01</span>
          <b>One scheduling engine</b>
          <p>
            Google and Outlook calendars are checked together before any time is
            suggested.
          </p>
        </div>
        <div>
          <span>02</span>
          <b>Drafts stay private</b>
          <p>Hot Potato never reads recipients, subjects, or message bodies.</p>
        </div>
        <div>
          <span>03</span>
          <b>Verified identity first</b>
          <p>
            Outlook matches the signed-in Microsoft account; revocable keys
            remain available as a fallback.
          </p>
        </div>
      </div>

      <div className="email-tools-grid">
        <article className="email-client-card gmail">
          <div className="email-client-heading">
            <span>G</span>
            <div>
              <small>GOOGLE WORKSPACE ADD-ON</small>
              <h3>Gmail</h3>
            </div>
            <b className={gmailConfigured ? "ready" : "setup"}>
              {gmailConfigured ? "SERVER VARS SET" : "NEEDS SERVER VARS"}
            </b>
          </div>
          <p>
            Gmail verifies the signed-in Google account and matches it to the
            rep email—no pairing key and no mailbox access.
          </p>
          <ul>
            <li>Works in Gmail web, iOS, and Android compose</li>
            <li>Inserts editable HTML at the cursor</li>
            <li>Requests no draft, recipient, or message-reading scope</li>
          </ul>
          <a
            href="https://developers.google.com/workspace/add-ons/gmail"
            target="_blank"
            rel="noreferrer"
          >
            Google Workspace add-on guide ↗
          </a>
        </article>

        <article className="email-client-card outlook">
          <div className="email-client-heading">
            <span>O</span>
            <div>
              <small>OUTLOOK TASK PANE</small>
              <h3>Outlook</h3>
            </div>
            <b className={outlookNaaConfigured ? "ready" : "setup"}>
              {outlookNaaConfigured
                ? "MICROSOFT SIGN-IN"
                : outlookNaaConfigurationError
                  ? "CHECK SERVER VARS"
                  : "PAIRING FALLBACK"}
            </b>
          </div>
          <p>
            Microsoft sign-in verifies the account already in Outlook. One
            fallback key binds its stable Microsoft identity to the intended
            representative; no Graph or mailbox permission is requested.
          </p>
          <ul>
            <li>Silent sign-in, popup, and Office dialog fallback</li>
            <li>Pairing keys remain scoped and independently revocable</li>
            <li>Calendar authorization stays completely separate</li>
          </ul>
          <label>
            Fallback representative
            <select
              value={repId}
              onChange={(event) => setRepId(event.target.value)}
            >
              {activeReps.map((rep) => (
                <option value={rep.id} key={rep.id}>
                  {rep.name} · {rep.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fallback key label
            <input
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void createKey()}
            disabled={busy || !repId}
          >
            {busy ? "Working…" : "Create fallback pairing key"}
            <span>↗</span>
          </button>
          <a href="/email/outlook" target="_blank" rel="noreferrer">
            Open the Outlook task pane preview ↗
          </a>
        </article>
      </div>

      {newToken && (
        <div className="email-token-reveal" role="status">
          <div>
            <small>SHOWN ONCE</small>
            <b>Use this key to link Microsoft once or as a fallback.</b>
            <p>
              Hot Potato stores only its SHA-256 fingerprint. If it is lost,
              revoke it and create another. This bearer key works anywhere it is
              pasted until you revoke it; revocation also disables the Microsoft
              identity linked through this key.
            </p>
          </div>
          <code>{newToken}</code>
          <button type="button" onClick={() => void copyToken()}>
            {copied ? "Copied ✓" : "Copy key"}
          </button>
        </div>
      )}

      <div className="email-key-list">
        <div className="email-key-list-heading">
          <div>
            <b>
              {selectedRep?.name ?? "Representative"}&apos;s Outlook fallback
              keys
            </b>
            <span>{keys.filter((key) => !key.revokedAt).length} active</span>
          </div>
          <small>
            Revocation disables both the fallback key and its linked Microsoft
            identity.
          </small>
        </div>
        {keys.length === 0 ? (
          <p className="email-key-empty">
            No Outlook fallback keys for this rep yet.
          </p>
        ) : (
          keys.map((key) => (
            <div
              className={`email-key-row${key.revokedAt ? " revoked" : ""}`}
              key={key.id}
            >
              <span className="email-key-icon">O</span>
              <div>
                <b>{key.label}</b>
                <small>
                  Created {shortDate(key.createdAt)} · Last used{" "}
                  {shortDate(key.lastUsedAt)}
                  {key.outlookIdentityLinked ? " · Microsoft linked" : ""}
                </small>
              </div>
              {key.revokedAt ? (
                <span className="email-key-status">REVOKED</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(key)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {error && (
        <p className="email-tools-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
