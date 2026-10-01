"use client";

import type { Dashboard } from "@hot-potato/db";
import { useMemo, useState } from "react";
import styles from "./workspace-launchpad.module.css";
import {
  deriveWorkspaceReadiness,
  type WorkspaceConnection,
} from "./workspace-readiness";

export function WorkspaceLaunchpad({
  dashboard,
  connections,
}: {
  dashboard: Dashboard;
  connections: WorkspaceConnection[];
}) {
  const readiness = useMemo(
    () => deriveWorkspaceReadiness(dashboard, connections),
    [connections, dashboard],
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const link = readiness.publishedLink;
  const linkPath = link
    ? `/r/${dashboard.organization.slug}/${link.slug}`
    : null;

  async function copyPublishedLink() {
    if (!linkPath) return;
    try {
      await navigator.clipboard.writeText(
        new URL(linkPath, window.location.origin).toString(),
      );
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <section
      className={`${styles.shell} ${readiness.complete ? styles.ready : ""}`}
      id="workspace-launchpad"
      aria-labelledby="workspace-launchpad-heading"
    >
      <div className={styles.intro}>
        <span className={styles.eyebrow}>
          {readiness.complete ? "READY TO ROUTE" : "GET LIVE WITH CONFIDENCE"}
        </span>
        <h2 id="workspace-launchpad-heading">
          {readiness.complete
            ? "Your routing experience is live."
            : "Launch your first Smart Router."}
        </h2>
        <p>
          {readiness.complete
            ? "Qualification, assignment, and a real booking destination are connected end to end."
            : "Finish one proven path from a qualified buyer to a confirmed Google or Outlook meeting."}
        </p>

        <div className={styles.progressCopy}>
          <span id="workspace-launchpad-progress-label">
            {readiness.completedStages} of {readiness.stages.length} stages
            complete
          </span>
          <progress
            aria-labelledby="workspace-launchpad-progress-label"
            max={readiness.stages.length}
            value={readiness.completedStages}
          />
        </div>

        {readiness.primaryAction && (
          <a
            className={styles.primaryAction}
            href={readiness.primaryAction.href}
          >
            {readiness.primaryAction.label}
            <span aria-hidden="true">↓</span>
          </a>
        )}
      </div>

      <ol className={styles.stages} aria-label="Workspace launch progress">
        {readiness.stages.map((stage, index) => (
          <li
            className={`${styles.stage} ${styles[stage.status]}`}
            key={stage.id}
            aria-current={stage.status === "current" ? "step" : undefined}
          >
            <div className={styles.stageHeading}>
              <span className={styles.stageMark} aria-hidden="true">
                {stage.status === "complete" ? "✓" : index + 1}
              </span>
              <span className={styles.stageStatus}>
                {stage.status === "complete"
                  ? "Complete"
                  : stage.status === "current"
                    ? "Up next"
                    : "Waiting"}
              </span>
            </div>
            <h3>{stage.title}</h3>
            <p>{stage.description}</p>
          </li>
        ))}
      </ol>

      {readiness.complete && linkPath && (
        <div className={styles.readyActions}>
          <div>
            <span>LIVE SMART LINK</span>
            <strong>{link?.name}</strong>
            <code>{linkPath}</code>
          </div>
          <nav aria-label="Ready workspace actions">
            <a href={linkPath} target="_blank" rel="noreferrer">
              Preview <span aria-hidden="true">↗</span>
            </a>
            <button type="button" onClick={() => void copyPublishedLink()}>
              {copyStatus === "copied" ? "Copied ✓" : "Copy link"}
            </button>
            <a href="#handoff-scheduler">Open handoff</a>
            <a href="#email-tools">Use in Gmail or Outlook</a>
          </nav>
          <p className={styles.copyStatus} aria-live="polite">
            {copyStatus === "copied"
              ? "Smart Link copied to the clipboard."
              : copyStatus === "error"
                ? "Copy failed. Open the preview and copy its address instead."
                : ""}
          </p>
        </div>
      )}
    </section>
  );
}
