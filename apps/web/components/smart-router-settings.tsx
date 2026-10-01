"use client";

import type { Dashboard, RouterLink, RouterLinkQuestion } from "@hot-potato/db";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  activeRules,
  compatibleMeetingTypes,
  reachablePools,
  readinessErrors,
  ruleFieldEvidence,
} from "./workspace-readiness";

type QuestionType = RouterLinkQuestion["type"];
type RouterLinkView = RouterLink;

type RouterLinkDraft = Omit<RouterLinkView, "id" | "destinations"> & {
  id?: string;
  destinations: Array<{ poolId: string; meetingTypeId: string }>;
};

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

const accentPattern = /^#[0-9a-fA-F]{6}$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function fieldLabel(field: string): string {
  return field
    .split(".")
    .at(-1)!
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    const option = String(value).trim();
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    result.push(option);
  }
  return result;
}

function generatedQuestions(
  dashboard: Dashboard,
  existing: RouterLinkQuestion[] = [],
): RouterLinkQuestion[] {
  const activeRuleCount = activeRules(dashboard).length;
  const existingByField = new Map(
    existing.map((question) => [question.field, question]),
  );
  return [...ruleFieldEvidence(dashboard)].map(([field, evidence]) => {
    const options = uniqueStrings([
      ...evidence.values,
      ...(evidence.hasBooleanValue ? [true, false] : []),
    ]);
    const type: QuestionType = evidence.hasNumberOperator
      ? "number"
      : evidence.hasChoiceOperator ||
          evidence.hasBooleanValue ||
          options.length > 1
        ? "select"
        : "text";
    const label = fieldLabel(field);
    const generated: RouterLinkQuestion = {
      field,
      label,
      type,
      required:
        activeRuleCount > 0 &&
        evidence.ruleIds.size === activeRuleCount &&
        !evidence.hasExistsFalse,
      placeholder:
        type === "select"
          ? "Choose an option"
          : type === "number"
            ? "Enter a number"
            : `Enter ${label.toLowerCase()}`,
      helpText: "",
      options: type === "select" ? options : [],
    };
    const saved = existingByField.get(field);
    return saved
      ? {
          ...generated,
          ...saved,
          field,
          options: saved.type === "select" ? saved.options : [],
        }
      : generated;
  });
}

function defaultDestinations(dashboard: Dashboard) {
  return reachablePools(dashboard).map((pool) => ({
    poolId: pool.id,
    meetingTypeId: compatibleMeetingTypes(dashboard, pool.id)[0]?.id ?? "",
  }));
}

function toDraft(link: RouterLinkView): RouterLinkDraft {
  return {
    id: link.id,
    name: link.name,
    slug: link.slug,
    title: link.title,
    description: link.description,
    buttonLabel: link.buttonLabel,
    noMatchMessage: link.noMatchMessage,
    successRedirectUrl: link.successRedirectUrl,
    successRedirectDelaySeconds: link.successRedirectDelaySeconds,
    accentColor: link.accentColor,
    active: link.active,
    questions: link.questions,
    destinations: link.destinations.map((destination) => ({
      poolId: destination.poolId,
      meetingTypeId: destination.meetingTypeId,
    })),
  };
}

function newDraft(dashboard: Dashboard): RouterLinkDraft {
  return {
    name: "New smart link",
    slug: "new-smart-link",
    title: "Find the right meeting for you",
    description:
      "Tell us a little about what you need, then choose a time that works.",
    buttonLabel: "Find my time",
    noMatchMessage:
      "Thanks for reaching out. Our team will follow up with the right next step.",
    successRedirectUrl: null,
    successRedirectDelaySeconds: 5,
    accentColor: "#ff5d2e",
    active: false,
    questions: generatedQuestions(dashboard),
    destinations: defaultDestinations(dashboard),
  };
}

function normalizedDestinations(draft: RouterLinkDraft, dashboard: Dashboard) {
  const reachable = new Set(reachablePools(dashboard).map((pool) => pool.id));
  return draft.destinations.filter(
    (destination) =>
      reachable.has(destination.poolId) && Boolean(destination.meetingTypeId),
  );
}

function readinessLabel(errors: string[], active: boolean): string {
  if (active && errors.length === 0) return "Published";
  if (active) return "Needs attention";
  if (errors.length === 0) return "Ready";
  return "Draft";
}

function statusClass(label: string): string {
  return label.toLowerCase().replaceAll(" ", "-");
}

export function SmartRouterSettings({
  dashboard,
  onRefresh,
  sectionNumber = "07",
}: {
  dashboard: Dashboard;
  onRefresh: () => Promise<void>;
  sectionNumber?: string;
}) {
  const routerLinks = dashboard.routerLinks;
  const [draft, setDraft] = useState<RouterLinkDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [savedActive, setSavedActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const readinessRef = useRef<HTMLDivElement>(null);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const currentErrors = useMemo(
    () => (draft ? readinessErrors(draft, dashboard) : []),
    [dashboard, draft],
  );

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!dirty || !draft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draft]);

  useEffect(() => {
    if (!draft?.id || dirty) return;
    const refreshed = routerLinks.find((link) => link.id === draft.id);
    if (!refreshed) return;
    const next = toDraft(refreshed);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setSavedActive(next.active);
  }, [dirty, draft?.id, routerLinks]);

  function canLeaveDraft(): boolean {
    return !dirty || window.confirm("Discard your unsaved Smart Link changes?");
  }

  function editLink(link: RouterLinkView) {
    if (!canLeaveDraft()) return;
    const next = toDraft(link);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setSavedActive(next.active);
    setNotice(null);
  }

  function addLink() {
    if (!canLeaveDraft()) return;
    const next = newDraft(dashboard);
    setDraft(next);
    setBaseline("");
    setSavedActive(false);
    setNotice(null);
  }

  function closeEditor() {
    if (!canLeaveDraft()) return;
    setDraft(null);
    setBaseline("");
    setNotice(null);
  }

  function updateDraft(changes: Partial<RouterLinkDraft>) {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  }

  function updateQuestion(index: number, changes: Partial<RouterLinkQuestion>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            questions: current.questions.map((question, questionIndex) =>
              questionIndex === index ? { ...question, ...changes } : question,
            ),
          }
        : current,
    );
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    setDraft((current) => {
      if (!current) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.questions.length)
        return current;
      const questions = [...current.questions];
      const [question] = questions.splice(index, 1);
      questions.splice(nextIndex, 0, question!);
      return { ...current, questions };
    });
  }

  function syncQuestions() {
    if (!draft) return;
    const questions = generatedQuestions(dashboard, draft.questions);
    updateDraft({ questions });
    setNotice({
      tone: questions.length > 20 ? "error" : "info",
      message:
        questions.length > 20
          ? `The active rules need ${questions.length} public fields. Reduce them to 20 before saving this Smart Link.`
          : "Questions now match the fields used by the active rules.",
    });
  }

  function updateDestination(poolId: string, meetingTypeId: string) {
    if (!draft) return;
    updateDraft({
      destinations: [
        ...draft.destinations.filter(
          (destination) => destination.poolId !== poolId,
        ),
        ...(meetingTypeId ? [{ poolId, meetingTypeId }] : []),
      ],
    });
  }

  async function copyValue(value: string, message: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyNotice(message);
    } catch {
      setCopyNotice("Copy failed. Select the text and copy it manually.");
    }
  }

  async function saveLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    const errors = readinessErrors(draft, dashboard);
    if (draft.active && errors.length > 0) {
      setNotice({
        tone: "error",
        message: "Resolve the readiness items before publishing this link.",
      });
      requestAnimationFrame(() => readinessRef.current?.focus());
      return;
    }

    setSaving(true);
    setNotice(null);
    const payload = {
      ...draft,
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      title: draft.title.trim(),
      description: draft.description.trim(),
      buttonLabel: draft.buttonLabel.trim(),
      noMatchMessage: draft.noMatchMessage.trim(),
      successRedirectUrl: draft.successRedirectUrl?.trim() || null,
      successRedirectDelaySeconds: draft.successRedirectDelaySeconds,
      accentColor: draft.accentColor,
      questions: draft.questions.map((question) => ({
        ...question,
        label: question.label.trim(),
        placeholder: question.placeholder.trim(),
        helpText: question.helpText.trim(),
        options:
          question.type === "select" ? uniqueStrings(question.options) : [],
      })),
      destinations: normalizedDestinations(draft, dashboard),
    };

    try {
      const response = await fetch("/api/settings/router-links", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !body.id) {
        setNotice({
          tone: "error",
          message: body.error ?? "The Smart Link could not be saved.",
        });
        return;
      }

      const saved: RouterLinkDraft = { ...payload, id: body.id };
      setDraft(saved);
      setBaseline(JSON.stringify(saved));
      setSavedActive(saved.active);
      setNotice({
        tone: "success",
        message: saved.active
          ? "Smart Link published."
          : savedActive
            ? "Smart Link paused and saved."
            : "Smart Link draft saved.",
      });
      await onRefresh();
    } catch {
      setNotice({
        tone: "error",
        message:
          "The Smart Link could not be saved. Check the connection and try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  const previewOrigin = origin || "https://your-hot-potato.example";
  const draftPath = draft
    ? `/r/${dashboard.organization.slug}/${draft.slug || "link-slug"}`
    : "";
  const draftUrl = `${previewOrigin}${draftPath}`;
  const embedSnippet = draft
    ? `<div data-hot-potato-router="${draftUrl}"><a href="${draftUrl}">Book a meeting</a></div>\n<script async src="${previewOrigin}/embed/v1.js"></script>`
    : "";

  return (
    <section
      className="smart-router-settings settings-card"
      id="smart-links"
      aria-labelledby="smart-links-heading"
    >
      <div className="card-heading">
        <div>
          <span className="section-number">{sectionNumber}</span>
          <div>
            <h2 id="smart-links-heading">Smart Router Links</h2>
            <p>Qualify a visitor, route them, and offer the right calendar.</p>
          </div>
        </div>
        <button type="button" onClick={addLink}>
          Add Smart Link
        </button>
      </div>

      {routerLinks.length === 0 ? (
        <div className="smart-link-empty">
          <span aria-hidden="true">↗</span>
          <h3>Turn your routing rules into a booking flow.</h3>
          <p>
            Create one link, answer a few readiness checks, then share it or
            embed it on your website.
          </p>
          <button type="button" onClick={addLink}>
            Create the first Smart Link
          </button>
        </div>
      ) : (
        <ul className="smart-link-list" aria-label="Saved Smart Router Links">
          {routerLinks.map((link) => {
            const errors = readinessErrors(toDraft(link), dashboard);
            const status = readinessLabel(errors, link.active);
            const path = `/r/${dashboard.organization.slug}/${link.slug}`;
            const fullUrl = origin ? `${origin}${path}` : path;
            return (
              <li key={link.id}>
                <div className="smart-link-row-summary">
                  <span className={`smart-link-status ${statusClass(status)}`}>
                    {status}
                  </span>
                  <div>
                    <h3>{link.name}</h3>
                    <code>{path}</code>
                  </div>
                </div>
                <p>
                  {errors.length === 0
                    ? `${link.questions.length} questions · ${link.destinations.length} destinations`
                    : `${errors.length} readiness item${errors.length === 1 ? "" : "s"}`}
                </p>
                <div className="smart-link-row-actions">
                  {link.active && (
                    <a href={path} target="_blank" rel="noreferrer">
                      Preview ↗
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={!origin}
                    onClick={() =>
                      void copyValue(fullUrl, `${link.name} link copied.`)
                    }
                  >
                    Copy link
                  </button>
                  <button type="button" onClick={() => editLink(link)}>
                    Edit
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {copyNotice && (
        <p className="smart-link-copy-notice" role="status">
          {copyNotice}
        </p>
      )}

      {draft && (
        <form className="smart-link-editor" onSubmit={saveLink}>
          <header className="smart-link-editor-header">
            <div>
              <button type="button" onClick={closeEditor}>
                ← Back to links
              </button>
              <span
                className={`smart-link-status ${statusClass(
                  readinessLabel(currentErrors, draft.active),
                )}`}
              >
                {readinessLabel(currentErrors, draft.active)}
              </span>
              <h3>{draft.name || "Untitled Smart Link"}</h3>
              {dirty && <small>Unsaved changes</small>}
            </div>
            <button type="submit" disabled={saving}>
              {saving
                ? "Saving…"
                : draft.active
                  ? savedActive
                    ? "Save published changes"
                    : "Publish link"
                  : savedActive
                    ? "Pause and save"
                    : "Save draft"}
            </button>
          </header>

          {notice && (
            <div
              className={`smart-link-notice ${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              {notice.message}
            </div>
          )}

          <section
            className="smart-link-editor-section"
            aria-labelledby="smart-link-basics-heading"
          >
            <div className="smart-link-editor-section-heading">
              <span>01</span>
              <div>
                <h4 id="smart-link-basics-heading">Basics</h4>
                <p>Name the link and set the public-facing copy.</p>
              </div>
            </div>
            <div className="smart-link-field-grid">
              <label htmlFor="smart-link-name">
                Internal name
                <input
                  id="smart-link-name"
                  required
                  minLength={2}
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    const previousAutoSlug = slugify(draft.name);
                    updateDraft({
                      name,
                      ...(!draft.id &&
                      (!draft.slug || draft.slug === previousAutoSlug)
                        ? { slug: slugify(name) }
                        : {}),
                    });
                  }}
                />
              </label>
              <label htmlFor="smart-link-slug">
                Public slug
                <input
                  id="smart-link-slug"
                  required
                  maxLength={80}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  value={draft.slug}
                  onChange={(event) =>
                    updateDraft({ slug: slugify(event.target.value) })
                  }
                />
                <small>{draftPath}</small>
              </label>
              <label className="wide-field" htmlFor="smart-link-title">
                Public title
                <input
                  id="smart-link-title"
                  required
                  minLength={2}
                  maxLength={160}
                  value={draft.title}
                  onChange={(event) =>
                    updateDraft({ title: event.target.value })
                  }
                />
              </label>
              <label className="wide-field" htmlFor="smart-link-description">
                Public description
                <textarea
                  id="smart-link-description"
                  maxLength={1000}
                  value={draft.description}
                  onChange={(event) =>
                    updateDraft({ description: event.target.value })
                  }
                />
              </label>
              <label htmlFor="smart-link-button-label">
                Form button
                <input
                  id="smart-link-button-label"
                  required
                  minLength={2}
                  maxLength={80}
                  value={draft.buttonLabel}
                  onChange={(event) =>
                    updateDraft({ buttonLabel: event.target.value })
                  }
                />
              </label>
              <label htmlFor="smart-link-accent-text">
                Accent color
                <span className="smart-link-color-control">
                  <input
                    type="color"
                    aria-label="Choose accent color"
                    value={
                      accentPattern.test(draft.accentColor)
                        ? draft.accentColor
                        : "#ff5d2e"
                    }
                    onChange={(event) =>
                      updateDraft({ accentColor: event.target.value })
                    }
                  />
                  <input
                    id="smart-link-accent-text"
                    required
                    pattern="#[0-9a-fA-F]{6}"
                    maxLength={7}
                    value={draft.accentColor}
                    onChange={(event) =>
                      updateDraft({ accentColor: event.target.value })
                    }
                  />
                </span>
              </label>
              <label className="wide-field" htmlFor="smart-link-no-match">
                No-match message
                <textarea
                  id="smart-link-no-match"
                  required
                  minLength={2}
                  maxLength={500}
                  value={draft.noMatchMessage}
                  onChange={(event) =>
                    updateDraft({ noMatchMessage: event.target.value })
                  }
                />
                <small>
                  Keep this helpful and neutral; never reveal internal routing
                  criteria.
                </small>
              </label>
              <label className="smart-link-active-toggle">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(event) =>
                    updateDraft({ active: event.target.checked })
                  }
                />
                <span>
                  <b>Public link active after save</b>
                  <small>
                    Publishing is blocked until every readiness item passes.
                  </small>
                </span>
              </label>
            </div>
          </section>

          <section
            className="smart-link-editor-section"
            aria-labelledby="smart-link-questions-heading"
          >
            <div className="smart-link-editor-section-heading">
              <span>02</span>
              <div>
                <h4 id="smart-link-questions-heading">Form questions</h4>
                <p>
                  Generated from the fields used by the current active rules.
                </p>
              </div>
              <button type="button" onClick={syncQuestions}>
                Sync with active rules
              </button>
            </div>
            {draft.questions.length === 0 ? (
              <div className="smart-link-inline-empty">
                Activate a routing rule, then sync its fields into this form.
              </div>
            ) : (
              <ol className="smart-link-question-list">
                {draft.questions.map((question, index) => {
                  const helpId = `smart-link-question-${index}-help`;
                  return (
                    <li key={question.field}>
                      <div className="smart-link-question-heading">
                        <div>
                          <span>QUESTION {index + 1}</span>
                          <code>{question.field}</code>
                        </div>
                        <div>
                          <button
                            type="button"
                            aria-label={`Move ${question.label || question.field} up`}
                            disabled={index === 0}
                            onClick={() => moveQuestion(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${question.label || question.field} down`}
                            disabled={index === draft.questions.length - 1}
                            onClick={() => moveQuestion(index, 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                      <div className="smart-link-question-fields">
                        <label>
                          Label
                          <input
                            required
                            maxLength={120}
                            aria-describedby={helpId}
                            value={question.label}
                            onChange={(event) =>
                              updateQuestion(index, {
                                label: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Answer type
                          <select
                            value={question.type}
                            onChange={(event) => {
                              const type = event.target.value as QuestionType;
                              updateQuestion(index, {
                                type,
                                options:
                                  type === "select" ? question.options : [],
                              });
                            }}
                          >
                            <option value="text">Short text</option>
                            <option value="number">Number</option>
                            <option value="select">Single select</option>
                          </select>
                        </label>
                        <label>
                          Placeholder
                          <input
                            maxLength={160}
                            value={question.placeholder}
                            onChange={(event) =>
                              updateQuestion(index, {
                                placeholder: event.target.value,
                              })
                            }
                          />
                        </label>
                        {question.type === "select" && (
                          <fieldset className="wide-field smart-link-options">
                            <legend>Options</legend>
                            {question.options.map((option, optionIndex) => (
                              <div key={`${question.field}-${optionIndex}`}>
                                <input
                                  required
                                  maxLength={100}
                                  aria-label={`${question.label || question.field} option ${optionIndex + 1}`}
                                  value={option}
                                  onChange={(event) =>
                                    updateQuestion(index, {
                                      options: question.options.map(
                                        (candidate, candidateIndex) =>
                                          candidateIndex === optionIndex
                                            ? event.target.value
                                            : candidate,
                                      ),
                                    })
                                  }
                                />
                                <button
                                  type="button"
                                  aria-label={`Remove ${question.label || question.field} option ${optionIndex + 1}`}
                                  onClick={() =>
                                    updateQuestion(index, {
                                      options: question.options.filter(
                                        (_, candidateIndex) =>
                                          candidateIndex !== optionIndex,
                                      ),
                                    })
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              disabled={question.options.length >= 50}
                              onClick={() =>
                                updateQuestion(index, {
                                  options: [...question.options, ""],
                                })
                              }
                            >
                              + Add option
                            </button>
                          </fieldset>
                        )}
                        <label className="wide-field">
                          Help text
                          <textarea
                            id={helpId}
                            maxLength={300}
                            value={question.helpText}
                            onChange={(event) =>
                              updateQuestion(index, {
                                helpText: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="smart-link-required-toggle">
                          <input
                            type="checkbox"
                            checked={question.required}
                            onChange={(event) =>
                              updateQuestion(index, {
                                required: event.target.checked,
                              })
                            }
                          />
                          Required question
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section
            className="smart-link-editor-section"
            aria-labelledby="smart-link-destinations-heading"
          >
            <div className="smart-link-editor-section-heading">
              <span>03</span>
              <div>
                <h4 id="smart-link-destinations-heading">Routing outcomes</h4>
                <p>Choose the booking experience for every reachable pool.</p>
              </div>
            </div>
            {reachablePools(dashboard).length === 0 ? (
              <div className="smart-link-inline-empty">
                Activate a rule that routes to a pool before publishing.
              </div>
            ) : (
              <div className="smart-link-destination-list">
                {reachablePools(dashboard).map((pool) => {
                  const selected = draft.destinations.find(
                    (destination) => destination.poolId === pool.id,
                  );
                  const options = compatibleMeetingTypes(dashboard, pool.id);
                  return (
                    <article key={pool.id}>
                      <div>
                        <span>DESTINATION POOL</span>
                        <h5>{pool.name}</h5>
                        <small>
                          Used by{" "}
                          {activeRules(dashboard)
                            .filter((rule) => rule.poolId === pool.id)
                            .map((rule) => rule.name)
                            .join(", ")}
                        </small>
                      </div>
                      <label>
                        Meeting type
                        <select
                          value={selected?.meetingTypeId ?? ""}
                          onChange={(event) =>
                            updateDestination(pool.id, event.target.value)
                          }
                        >
                          <option value="">Choose a pool meeting type</option>
                          {options.map((meetingType) => (
                            <option value={meetingType.id} key={meetingType.id}>
                              {meetingType.title} ·{" "}
                              {meetingType.durationMinutes} min
                            </option>
                          ))}
                        </select>
                        {options.length === 0 && (
                          <small>
                            Create and activate a meeting type targeting this
                            pool.
                          </small>
                        )}
                      </label>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section
            className="smart-link-editor-section"
            aria-labelledby="smart-link-conversion-heading"
          >
            <div className="smart-link-editor-section-heading">
              <span>04</span>
              <div>
                <h4 id="smart-link-conversion-heading">After booking</h4>
                <p>
                  Keep the confirmation visible or continue the buyer to a
                  trusted next page.
                </p>
              </div>
            </div>
            <div className="smart-link-field-grid">
              <label className="wide-field" htmlFor="smart-link-redirect-url">
                Success redirect URL
                <input
                  id="smart-link-redirect-url"
                  type="url"
                  inputMode="url"
                  maxLength={2048}
                  placeholder="https://www.example.com/thank-you"
                  value={draft.successRedirectUrl ?? ""}
                  onChange={(event) =>
                    updateDraft({
                      successRedirectUrl: event.target.value || null,
                    })
                  }
                />
                <small>
                  Optional. Runs only after Hot Potato confirms the Google or
                  Outlook calendar write. Embedded hosts can cancel the redirect
                  from the booked event.
                </small>
              </label>
              <label htmlFor="smart-link-redirect-delay">
                Confirmation time
                <span className="smart-link-number-control">
                  <input
                    id="smart-link-redirect-delay"
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    required
                    value={draft.successRedirectDelaySeconds}
                    onChange={(event) =>
                      updateDraft({
                        successRedirectDelaySeconds: Number(event.target.value),
                      })
                    }
                  />
                  <span>seconds</span>
                </span>
              </label>
            </div>
          </section>

          <section
            className="smart-link-editor-section smart-link-deploy"
            aria-labelledby="smart-link-deploy-heading"
          >
            <div className="smart-link-editor-section-heading">
              <span>05</span>
              <div>
                <h4 id="smart-link-deploy-heading">Readiness and deploy</h4>
                <p>Publish confidently, then share or embed the same flow.</p>
              </div>
            </div>
            <div
              className={`smart-link-readiness ${
                currentErrors.length === 0 ? "ready" : "not-ready"
              }`}
              id="smart-link-readiness"
              ref={readinessRef}
              tabIndex={-1}
            >
              <div>
                <span aria-hidden="true">
                  {currentErrors.length === 0 ? "✓" : "!"}
                </span>
                <div>
                  <h5>
                    {currentErrors.length === 0
                      ? "Ready to publish"
                      : `${currentErrors.length} readiness item${currentErrors.length === 1 ? "" : "s"}`}
                  </h5>
                  <p>
                    {currentErrors.length === 0
                      ? "Every rule field and destination has a public path."
                      : "Drafts can still be saved while you finish setup."}
                  </p>
                </div>
              </div>
              {currentErrors.length > 0 && (
                <ul>
                  {currentErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="smart-link-deploy-option">
              <div>
                <span>STANDALONE LINK</span>
                <p>Use this in email, social, or any ordinary link.</p>
              </div>
              <code>{draftUrl}</code>
              <div>
                <button
                  type="button"
                  disabled={!origin}
                  onClick={() =>
                    void copyValue(draftUrl, "Standalone link copied.")
                  }
                >
                  Copy link
                </button>
                {draft.id && draft.active && (
                  <a href={draftPath} target="_blank" rel="noreferrer">
                    Open preview ↗
                  </a>
                )}
              </div>
            </div>

            <div className="smart-link-deploy-option">
              <div>
                <span>RESPONSIVE EMBED</span>
                <p>
                  The link remains available as a fallback before JavaScript
                  loads.
                </p>
              </div>
              <pre tabIndex={0}>
                <code>{embedSnippet}</code>
              </pre>
              <button
                type="button"
                disabled={!origin}
                onClick={() =>
                  void copyValue(embedSnippet, "Embed snippet copied.")
                }
              >
                Copy embed code
              </button>
            </div>
          </section>
        </form>
      )}
    </section>
  );
}
