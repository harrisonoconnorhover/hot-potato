"use client";

import type { OperatorRole } from "@hot-potato/db";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "./people-access.module.css";

type Member = {
  operatorId: string;
  login: string;
  displayName: string;
  role: OperatorRole;
  active: boolean;
  joinedAt: string;
  lastSeenAt: string | null;
  activeSessionCount: number;
  repId: string | null;
  repName: string | null;
  googleConnected: boolean;
  microsoftConnected: boolean;
};

type Invitation = {
  id: string;
  login: string;
  displayName: string;
  role: OperatorRole;
  createdAt: string;
  expiresAt: string;
};

type Overview = {
  members: Member[];
  invitations: Invitation[];
  currentOperatorId: string;
};

type AccessReveal = {
  kind: "invite" | "reset";
  url: string;
  login: string;
};

const roleLabels: Record<OperatorRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatSeen(value: string | null): string {
  if (!value) return "Never signed in";
  return `Seen ${new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  }).format(
    Math.round((new Date(value).getTime() - Date.now()) / 86_400_000),
    "day",
  )}`;
}

async function responseBody(response: Response): Promise<{
  error?: string;
  accessUrl?: string;
}> {
  return (await response.json().catch(() => ({}))) as {
    error?: string;
    accessUrl?: string;
  };
}

export function PeopleAccess({ currentRole }: { currentRole: OperatorRole }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [reveal, setReveal] = useState<AccessReveal | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/operators", {
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as Overview & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? "People and access could not be loaded.");
    }
    setOverview(body);
  }, []);

  useEffect(() => {
    load()
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "People and access could not be loaded.",
        }),
      )
      .finally(() => setLoading(false));
  }, [load]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy("invite");
    setNotice(null);
    setReveal(null);
    try {
      const response = await fetch("/api/settings/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: data.get("displayName"),
          login: data.get("login"),
          role: data.get("role"),
        }),
      });
      const body = await responseBody(response);
      if (!response.ok || !body.accessUrl) {
        throw new Error(body.error ?? "The invitation could not be created.");
      }
      const login = String(data.get("login") ?? "");
      setReveal({ kind: "invite", url: body.accessUrl, login });
      setNotice({
        tone: "success",
        message: "Invitation ready. Share the one-time link below.",
      });
      form.reset();
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Invitation failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function updateMember(
    member: Member,
    update: { role?: OperatorRole; active?: boolean },
  ) {
    setBusy(`member:${member.operatorId}`);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/settings/operators/${member.operatorId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      const body = await responseBody(response);
      if (!response.ok) {
        throw new Error(body.error ?? "The member could not be updated.");
      }
      setNotice({
        tone: "success",
        message:
          update.active === false
            ? `${member.displayName}'s access is paused and their sessions were revoked.`
            : update.active === true
              ? `${member.displayName}'s access is active again.`
              : `${member.displayName}'s role is now ${roleLabels[update.role!]}.`,
      });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Member update failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function createReset(member: Member) {
    setBusy(`reset:${member.operatorId}`);
    setNotice(null);
    setReveal(null);
    try {
      const response = await fetch(
        `/api/settings/operators/${member.operatorId}/reset`,
        { method: "POST" },
      );
      const body = await responseBody(response);
      if (!response.ok || !body.accessUrl) {
        throw new Error(body.error ?? "The reset link could not be created.");
      }
      setReveal({
        kind: "reset",
        url: body.accessUrl,
        login: member.login,
      });
      setNotice({
        tone: "success",
        message: "Password-reset link ready. It expires in 30 minutes.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Reset link failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    setBusy(`invite:${invitation.id}`);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/settings/operator-invitations/${invitation.id}`,
        { method: "DELETE" },
      );
      const body = await responseBody(response);
      if (!response.ok) {
        throw new Error(body.error ?? "The invitation could not be revoked.");
      }
      setNotice({
        tone: "success",
        message: `Invitation for ${invitation.login} revoked.`,
      });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Invitation update failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function copyAccessUrl() {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.url);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section
      className={styles.shell}
      id="people-access"
      aria-labelledby="people-access-heading"
    >
      <header className={styles.heading}>
        <div>
          <span>PEOPLE &amp; ACCESS</span>
          <h2 id="people-access-heading">Give every operator their own key.</h2>
          <p>
            Invite named teammates, assign only the access they need, and see
            whether their matching rep has Google or Outlook connected.
          </p>
        </div>
        <dl>
          <div>
            <dt>Active</dt>
            <dd>
              {overview?.members.filter((member) => member.active).length ??
                "—"}
            </dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd>{overview?.invitations.length ?? "—"}</dd>
          </div>
        </dl>
      </header>

      <div className={styles.inviteGrid}>
        <form onSubmit={invite} className={styles.inviteForm}>
          <div>
            <span>INVITE A TEAMMATE</span>
            <p>The one-time link is shown only after creation.</p>
          </div>
          <label>
            Name
            <input name="displayName" required maxLength={120} />
          </label>
          <label>
            Work email
            <input name="login" type="email" required maxLength={254} />
          </label>
          <label>
            Role
            <select name="role" defaultValue="operator">
              <option value="operator">Operator · route and report</option>
              <option value="admin">Admin · configure workspace</option>
              {currentRole === "owner" && (
                <option value="owner">Owner · manage all access</option>
              )}
            </select>
          </label>
          <button type="submit" disabled={busy !== null}>
            {busy === "invite" ? "Creating…" : "Create invite link"}
          </button>
        </form>

        <div className={styles.accessReveal} aria-live="polite">
          {reveal ? (
            <>
              <span>
                {reveal.kind === "invite"
                  ? "ONE-TIME INVITATION"
                  : "30-MINUTE RESET"}
              </span>
              <strong>{reveal.login}</strong>
              <code>{reveal.url}</code>
              <div>
                <button type="button" onClick={() => void copyAccessUrl()}>
                  {copyState === "copied" ? "Copied ✓" : "Copy secure link"}
                </button>
                <a
                  href={`mailto:${encodeURIComponent(reveal.login)}?subject=${encodeURIComponent("Your Hot Potato workspace access")}&body=${encodeURIComponent(`Use this one-time link to finish your Hot Potato access:\n\n${reveal.url}`)}`}
                >
                  Open email
                </a>
              </div>
              {copyState === "error" && (
                <small>Select and copy the link manually.</small>
              )}
            </>
          ) : (
            <>
              <span>LINKS STAY PRIVATE</span>
              <strong>Nothing reusable is stored here.</strong>
              <p>
                Hot Potato keeps only a SHA-256 hash. If a link is lost, revoke
                it and create another.
              </p>
            </>
          )}
        </div>
      </div>

      {notice && (
        <p className={`${styles.notice} ${styles[notice.tone]}`} role="status">
          {notice.message}
        </p>
      )}

      <div className={styles.tableWrap} aria-busy={loading}>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Calendar readiness</th>
              <th>Access</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {overview?.members.map((member) => {
              const self = member.operatorId === overview.currentOperatorId;
              const protectedOwner =
                currentRole !== "owner" && member.role === "owner";
              const memberBusy = busy?.endsWith(member.operatorId) ?? false;
              return (
                <tr
                  key={member.operatorId}
                  className={!member.active ? styles.inactive : ""}
                >
                  <td data-label="Person">
                    <strong>{member.displayName}</strong>
                    <small>{member.login}</small>
                    <span>{self ? "YOU" : formatSeen(member.lastSeenAt)}</span>
                  </td>
                  <td data-label="Role">
                    <select
                      aria-label={`Role for ${member.displayName}`}
                      value={member.role}
                      disabled={self || protectedOwner || memberBusy}
                      onChange={(event) =>
                        void updateMember(member, {
                          role: event.target.value as OperatorRole,
                        })
                      }
                    >
                      <option value="operator">Operator</option>
                      <option value="admin">Admin</option>
                      {(currentRole === "owner" || member.role === "owner") && (
                        <option value="owner">Owner</option>
                      )}
                    </select>
                  </td>
                  <td data-label="Calendar readiness">
                    {member.repId ? (
                      <div className={styles.providers}>
                        <span
                          className={
                            member.googleConnected ? styles.connected : ""
                          }
                        >
                          G{" "}
                          {member.googleConnected
                            ? "Connected"
                            : "Not connected"}
                        </span>
                        <span
                          className={
                            member.microsoftConnected ? styles.connected : ""
                          }
                        >
                          O{" "}
                          {member.microsoftConnected
                            ? "Connected"
                            : "Not connected"}
                        </span>
                      </div>
                    ) : (
                      <small>No rep with this email</small>
                    )}
                  </td>
                  <td data-label="Access">
                    <span
                      className={
                        member.active ? styles.activePill : styles.pausedPill
                      }
                    >
                      {member.active ? "Active" : "Paused"}
                    </span>
                    <small>
                      {member.activeSessionCount} active session
                      {member.activeSessionCount === 1 ? "" : "s"}
                    </small>
                  </td>
                  <td data-label="Actions">
                    <div className={styles.rowActions}>
                      {!self && !protectedOwner && member.active && (
                        <button
                          type="button"
                          disabled={memberBusy}
                          onClick={() => void createReset(member)}
                        >
                          Reset link
                        </button>
                      )}
                      {!self && !protectedOwner && (
                        <button
                          type="button"
                          className={member.active ? styles.danger : ""}
                          disabled={memberBusy}
                          onClick={() =>
                            void updateMember(member, {
                              active: !member.active,
                            })
                          }
                        >
                          {member.active ? "Pause access" : "Reactivate"}
                        </button>
                      )}
                      {self && <small>Manage below</small>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && overview?.members.length === 0 && (
              <tr>
                <td colSpan={5}>No members found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {Boolean(overview?.invitations.length) && (
        <div className={styles.pending}>
          <div>
            <span>PENDING INVITATIONS</span>
            <p>Expired links disappear automatically.</p>
          </div>
          <ul>
            {overview!.invitations.map((invitation) => (
              <li key={invitation.id}>
                <div>
                  <strong>{invitation.displayName}</strong>
                  <small>
                    {invitation.login} · {roleLabels[invitation.role]} · expires{" "}
                    {formatDate(invitation.expiresAt)}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy === `invite:${invitation.id}`}
                  onClick={() => void revokeInvitation(invitation)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
