"use client";

import type { Dashboard, RouterFormBridge, RouterLink } from "@hot-potato/db";
import { useEffect, useMemo, useState, type FormEvent } from "react";

type BridgeDraft = {
  id?: string;
  name: string;
  routerLinkId: string;
  provider: "hubspot" | "manual";
  formId: string;
  allowedOrigins: string;
  attendeeNameFields: string[];
  attendeeEmailField: string;
  answerMappings: Record<string, string>;
  active: boolean;
};

type Notice = { tone: "success" | "error"; message: string };

function defaultSourceField(
  field: string,
  provider: BridgeDraft["provider"],
): string {
  const finalPart = field.split(".").at(-1) ?? field;
  if (provider === "hubspot") {
    const objectType = field.startsWith("company.") ? "0-2" : "0-1";
    const property =
      finalPart === "employee_count" ? "numberofemployees" : finalPart;
    return `${objectType}/${property}`;
  }
  return finalPart;
}

function answerMappings(
  link: RouterLink | undefined,
  current: Record<string, string> = {},
  provider: BridgeDraft["provider"] = "hubspot",
): Record<string, string> {
  return Object.fromEntries(
    (link?.questions ?? []).map((question) => [
      question.field,
      current[question.field] ?? defaultSourceField(question.field, provider),
    ]),
  );
}

function identityDefaults(provider: BridgeDraft["provider"]): {
  nameFields: string[];
  emailField: string;
} {
  return provider === "hubspot"
    ? {
        nameFields: ["0-1/firstname", "0-1/lastname"],
        emailField: "0-1/email",
      }
    : { nameFields: ["firstname", "lastname"], emailField: "email" };
}

function emptyDraft(link: RouterLink | undefined): BridgeDraft {
  const identity = identityDefaults("hubspot");
  return {
    name: link ? `${link.name} · website form` : "Website form",
    routerLinkId: link?.id ?? "",
    provider: "hubspot",
    formId: "",
    allowedOrigins: "",
    attendeeNameFields: identity.nameFields,
    attendeeEmailField: identity.emailField,
    answerMappings: answerMappings(link, {}, "hubspot"),
    active: false,
  };
}

function draftFromBridge(bridge: RouterFormBridge): BridgeDraft {
  return {
    id: bridge.id,
    name: bridge.name,
    routerLinkId: bridge.routerLinkId,
    provider: bridge.provider,
    formId: bridge.formId ?? "",
    allowedOrigins: bridge.allowedOrigins.join("\n"),
    attendeeNameFields: bridge.attendeeNameFields,
    attendeeEmailField: bridge.attendeeEmailField,
    answerMappings: bridge.answerMappings,
    active: bridge.active,
  };
}

function parsedOrigins(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
}

function bridgeStatus(
  bridge: RouterFormBridge,
  link: RouterLink | undefined,
): { label: string; className: string } {
  if (bridge.linkConfigVersion !== bridge.currentLinkConfigVersion) {
    return { label: "Review mapping", className: "needs-attention" };
  }
  if (!link?.active || !bridge.active) {
    return { label: "Paused", className: "paused" };
  }
  return { label: "Listening", className: "published" };
}

export function FormBridgeSettings({
  dashboard,
  onRefresh,
  sectionNumber = "08",
}: {
  dashboard: Dashboard;
  onRefresh: () => Promise<void>;
  sectionNumber?: string;
}) {
  const links = useMemo(
    () =>
      [...dashboard.routerLinks].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [dashboard.routerLinks],
  );
  const [draft, setDraft] = useState<BridgeDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  const selectedLink = links.find((link) => link.id === draft?.routerLinkId);
  const savedBridge = draft?.id
    ? dashboard.routerFormBridges.find((bridge) => bridge.id === draft.id)
    : undefined;
  const stale = Boolean(
    savedBridge &&
      savedBridge.linkConfigVersion !== savedBridge.currentLinkConfigVersion,
  );
  const snippet =
    draft?.id && origin
      ? `<script src="${origin}/embed/v1.js"></script>\n<div data-hot-potato-form-bridge="${draft.id}"></div>`
      : "Save this bridge to generate its installation snippet.";
  const manualExample = draft?.id
    ? `await window.HotPotatoForms.open("${draft.id}", {\n  submissionId: result.id,\n  values: Object.fromEntries(new FormData(form))\n});`
    : "Save this bridge to generate the verified-success callback.";

  function newBridge() {
    setDraft(emptyDraft(links.find((link) => link.active) ?? links[0]));
    setNotice(null);
    setCopied(null);
  }

  function chooseLink(routerLinkId: string) {
    const link = links.find((candidate) => candidate.id === routerLinkId);
    setDraft((current) =>
      current
        ? {
            ...current,
            routerLinkId,
            active: current.active && Boolean(link?.active),
            answerMappings: answerMappings(
              link,
              current.answerMappings,
              current.provider,
            ),
          }
        : current,
    );
  }

  function chooseProvider(provider: BridgeDraft["provider"]) {
    setDraft((current) => {
      if (!current || current.provider === provider) return current;
      const previousIdentity = identityDefaults(current.provider);
      const nextIdentity = identityDefaults(provider);
      const previousMappings = answerMappings(
        selectedLink,
        {},
        current.provider,
      );
      const nextMappings = answerMappings(selectedLink, {}, provider);
      return {
        ...current,
        provider,
        formId: provider === "hubspot" ? current.formId : "",
        attendeeNameFields:
          JSON.stringify(current.attendeeNameFields) ===
          JSON.stringify(previousIdentity.nameFields)
            ? nextIdentity.nameFields
            : current.attendeeNameFields,
        attendeeEmailField:
          current.attendeeEmailField === previousIdentity.emailField
            ? nextIdentity.emailField
            : current.attendeeEmailField,
        answerMappings: Object.fromEntries(
          Object.keys(nextMappings).map((field) => {
            const nextValue =
              nextMappings[field] ?? defaultSourceField(field, provider);
            const currentValue = current.answerMappings[field];
            return [
              field,
              currentValue === previousMappings[field]
                ? nextValue
                : (currentValue ?? nextValue),
            ];
          }),
        ) as Record<string, string>,
      };
    });
  }

  function updateNameField(index: number, value: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            attendeeNameFields: current.attendeeNameFields.map(
              (field, fieldIndex) => (fieldIndex === index ? value : field),
            ),
          }
        : current,
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !selectedLink) return;
    const listening = draft.active && selectedLink.active;
    const normalizedMappings = answerMappings(
      selectedLink,
      draft.answerMappings,
      draft.provider,
    );
    const normalizedOrigins = parsedOrigins(draft.allowedOrigins);
    const normalizedNameFields = draft.attendeeNameFields.map((field) =>
      field.trim(),
    );
    const normalizedFormId =
      draft.provider === "hubspot" ? draft.formId.trim() : "";
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/router-form-bridges", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          routerLinkId: draft.routerLinkId,
          provider: draft.provider,
          formId: draft.provider === "hubspot" ? normalizedFormId : null,
          allowedOrigins: normalizedOrigins,
          attendeeNameFields: normalizedNameFields,
          attendeeEmailField: draft.attendeeEmailField.trim(),
          answerMappings: normalizedMappings,
          active: listening,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? "The form bridge could not be saved.");
      }
      setDraft({
        ...draft,
        id: body.id,
        name: draft.name.trim(),
        formId: normalizedFormId,
        allowedOrigins: normalizedOrigins.join("\n"),
        attendeeNameFields: normalizedNameFields,
        attendeeEmailField: draft.attendeeEmailField.trim(),
        answerMappings: normalizedMappings,
        active: listening,
      });
      let refreshFailed = false;
      try {
        await onRefresh();
      } catch {
        refreshFailed = true;
      }
      setNotice({
        tone: refreshFailed ? "error" : "success",
        message: refreshFailed
          ? "Form bridge saved, but the workspace could not refresh. Reload to see its latest status."
          : listening
            ? "Form bridge is listening. Copy the installation snippet below."
            : selectedLink.active
              ? "Form bridge saved as paused."
              : "Form bridge saved as paused because its Smart Link is paused.",
      });
    } catch (caught) {
      setNotice({
        tone: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "The form bridge could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function removeBridge(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setDeleting(id);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/settings/router-form-bridges/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        deleted?: boolean;
        error?: string;
      };
      if (!response.ok || !body.deleted) {
        throw new Error(body.error ?? "The form bridge could not be deleted.");
      }
      if (draft?.id === id) setDraft(null);
      setConfirmDelete(null);
      await onRefresh();
      setNotice({ tone: "success", message: "Form bridge deleted." });
    } catch (caught) {
      setNotice({
        tone: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "The form bridge could not be deleted.",
      });
    } finally {
      setDeleting(null);
    }
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied("error");
    }
  }

  return (
    <section
      className="form-bridge-settings settings-card"
      id="form-bridges"
      aria-labelledby="form-bridges-heading"
    >
      <div className="card-heading">
        <div>
          <span className="section-number">{sectionNumber}</span>
          <div>
            <h2 id="form-bridges-heading">Existing form bridges</h2>
            <p>
              Keep your form. Replace its thank-you with the right calendar.
            </p>
          </div>
        </div>
        <button type="button" onClick={newBridge} disabled={links.length === 0}>
          Add form bridge
        </button>
      </div>

      <div className="form-bridge-principles" aria-label="Form bridge behavior">
        <article>
          <span>01</span>
          <b>Your form submits first</b>
          <p>Hot Potato never blocks validation, consent, or CRM capture.</p>
        </article>
        <article>
          <span>02</span>
          <b>Only mapped fields move</b>
          <p>No draft scraping, URL parameters, or surprise data collection.</p>
        </article>
        <article>
          <span>03</span>
          <b>Failure stays invisible</b>
          <p>
            If scheduling cannot load, the original thank-you remains intact.
          </p>
        </article>
      </div>

      {notice && (
        <p
          className={`form-bridge-notice ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}

      {dashboard.routerFormBridges.length === 0 && !draft ? (
        <div className="form-bridge-empty">
          <span aria-hidden="true">↗</span>
          <h3>Turn a successful form submission into a live handoff.</h3>
          <p>
            Map the fields you already collect, listen for confirmed success,
            and show the matched calendar without rebuilding your landing page.
          </p>
          <button
            type="button"
            onClick={newBridge}
            disabled={links.length === 0}
          >
            Configure the first bridge
          </button>
        </div>
      ) : (
        <ul className="form-bridge-list" aria-label="Saved form bridges">
          {dashboard.routerFormBridges.map((bridge) => {
            const link = links.find(
              (candidate) => candidate.id === bridge.routerLinkId,
            );
            const status = bridgeStatus(bridge, link);
            return (
              <li key={bridge.id}>
                <div>
                  <span className={`smart-link-status ${status.className}`}>
                    {status.label}
                  </span>
                  <div>
                    <h3>{bridge.name}</h3>
                    <small>
                      {bridge.provider === "hubspot"
                        ? "HubSpot · updated editor"
                        : "Manual API"}
                      {" · "}
                      {bridge.routerLinkName}
                    </small>
                  </div>
                </div>
                <p>
                  {bridge.allowedOrigins.length} website origin
                  {bridge.allowedOrigins.length === 1 ? "" : "s"} ·{" "}
                  {Object.keys(bridge.answerMappings).length + 2} mapped fields
                </p>
                <div className="form-bridge-row-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(draftFromBridge(bridge));
                      setNotice(null);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={confirmDelete === bridge.id ? "danger" : ""}
                    disabled={deleting === bridge.id}
                    onClick={() => void removeBridge(bridge.id)}
                    onBlur={() => setConfirmDelete(null)}
                  >
                    {deleting === bridge.id
                      ? "Deleting…"
                      : confirmDelete === bridge.id
                        ? "Delete now"
                        : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <form className="form-bridge-editor" onSubmit={save}>
          <header>
            <div>
              <button type="button" onClick={() => setDraft(null)}>
                ← Back to bridges
              </button>
              <h3>{draft.name || "Untitled form bridge"}</h3>
              {stale && <span>Mapping review required</span>}
            </div>
            <button type="submit" disabled={saving || !selectedLink}>
              {saving
                ? "Saving…"
                : draft.active
                  ? "Save and listen"
                  : "Save paused"}
            </button>
          </header>

          <div className="form-bridge-editor-grid">
            <section>
              <div className="form-bridge-section-heading">
                <span>01</span>
                <div>
                  <h4>Source and destination</h4>
                  <p>Choose the verified success signal and Smart Link.</p>
                </div>
              </div>
              <div className="form-bridge-fields">
                <label>
                  Internal name
                  <input
                    required
                    minLength={2}
                    maxLength={120}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Smart Router Link
                  <select
                    required
                    value={draft.routerLinkId}
                    onChange={(event) => chooseLink(event.target.value)}
                  >
                    {links.map((link) => (
                      <option key={link.id} value={link.id}>
                        {link.name}
                        {link.active ? "" : " · paused"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Form system
                  <select
                    value={draft.provider}
                    onChange={(event) =>
                      chooseProvider(
                        event.target.value as BridgeDraft["provider"],
                      )
                    }
                  >
                    <option value="hubspot">
                      HubSpot Forms · updated editor
                    </option>
                    <option value="manual">
                      Verified-success JavaScript API
                    </option>
                  </select>
                </label>
                {draft.provider === "hubspot" && (
                  <label>
                    Exact HubSpot form ID
                    <input
                      required
                      maxLength={160}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      value={draft.formId}
                      onChange={(event) =>
                        setDraft({ ...draft, formId: event.target.value })
                      }
                    />
                    <small>
                      Uses HubSpot&apos;s official updated-editor success event.
                      For a legacy form, choose the verified-success API.
                      Disable redirects so the calendar can stay on the page.
                    </small>
                  </label>
                )}
                <label className="wide-field">
                  Allowed website origins · one per line
                  <textarea
                    required
                    rows={3}
                    maxLength={20500}
                    value={draft.allowedOrigins}
                    placeholder="https://www.example.com"
                    onChange={(event) =>
                      setDraft({ ...draft, allowedOrigins: event.target.value })
                    }
                  />
                  <small>
                    Exact origins only—no paths, wildcards, usernames, or query
                    strings.
                  </small>
                </label>
              </div>
            </section>

            <section>
              <div className="form-bridge-section-heading">
                <span>02</span>
                <div>
                  <h4>Field mapping</h4>
                  <p>
                    {draft.provider === "hubspot"
                      ? "Use exact updated-editor names such as 0-1/firstname and 0-2/numberofemployees."
                      : "Use the exact names your form passes in the verified-success callback."}
                  </p>
                </div>
              </div>
              <div className="form-bridge-map-list">
                <fieldset>
                  <legend>Attendee name</legend>
                  {draft.attendeeNameFields.map((field, index) => (
                    <div key={index}>
                      <input
                        required
                        maxLength={160}
                        aria-label={`Attendee name source field ${index + 1}`}
                        placeholder={index === 0 ? "firstname" : "lastname"}
                        value={field}
                        onChange={(event) =>
                          updateNameField(index, event.target.value)
                        }
                      />
                      {draft.attendeeNameFields.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove attendee name source field ${index + 1}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              attendeeNameFields:
                                draft.attendeeNameFields.filter(
                                  (_candidate, fieldIndex) =>
                                    fieldIndex !== index,
                                ),
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {draft.attendeeNameFields.length < 4 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          attendeeNameFields: [...draft.attendeeNameFields, ""],
                        })
                      }
                    >
                      + Add another name field
                    </button>
                  )}
                </fieldset>
                <label>
                  <span>
                    <b>Attendee email</b>
                    <code>email</code>
                  </span>
                  <input
                    required
                    maxLength={160}
                    value={draft.attendeeEmailField}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        attendeeEmailField: event.target.value,
                      })
                    }
                  />
                </label>
                {selectedLink?.questions.map((question) => (
                  <label key={question.field}>
                    <span>
                      <b>{question.label}</b>
                      <code>{question.field}</code>
                    </span>
                    <input
                      required
                      maxLength={160}
                      value={draft.answerMappings[question.field] ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          answerMappings: {
                            ...draft.answerMappings,
                            [question.field]: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="form-bridge-deploy">
              <div className="form-bridge-section-heading">
                <span>03</span>
                <div>
                  <h4>Install and listen</h4>
                  <p>
                    One marker, one loader, and no lead data in the snippet.
                  </p>
                </div>
              </div>
              <div className="form-bridge-code-grid">
                <div>
                  <b>Website snippet</b>
                  <p>
                    {draft.provider === "hubspot"
                      ? "Load this before the HubSpot form embed so no success event can race the listener."
                      : "Load once on the form page; the marker may sit anywhere on that page."}
                  </p>
                  <pre tabIndex={0}>
                    <code>{snippet}</code>
                  </pre>
                  <button
                    type="button"
                    disabled={!draft.id || !origin}
                    onClick={() => void copy(snippet, "snippet")}
                  >
                    {copied === "snippet"
                      ? "Copied ✓"
                      : "Copy installation snippet"}
                  </button>
                </div>
                <div>
                  <b>Manual verified-success callback</b>
                  <p>
                    Call only after your form provider confirms persistence. The
                    submission ID makes repeated callbacks harmless.
                  </p>
                  <pre tabIndex={0}>
                    <code>{manualExample}</code>
                  </pre>
                  <button
                    type="button"
                    disabled={!draft.id}
                    onClick={() => void copy(manualExample, "manual")}
                  >
                    {copied === "manual" ? "Copied ✓" : "Copy callback example"}
                  </button>
                </div>
              </div>
              {copied === "error" && (
                <p className="form-bridge-copy-error" role="alert">
                  Copy failed. Select the code and copy it manually.
                </p>
              )}
              <label className="form-bridge-active-toggle">
                <input
                  type="checkbox"
                  checked={draft.active && Boolean(selectedLink?.active)}
                  disabled={!selectedLink?.active}
                  onChange={(event) =>
                    setDraft({ ...draft, active: event.target.checked })
                  }
                />
                <span>
                  <b>Listen for verified submissions after save</b>
                  <small>
                    {selectedLink?.active
                      ? "Pausing leaves the original form and thank-you untouched."
                      : "Publish the selected Smart Link before this bridge can listen."}
                  </small>
                </span>
              </label>
            </section>
          </div>
        </form>
      )}
    </section>
  );
}
