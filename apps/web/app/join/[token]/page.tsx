import type { Metadata } from "next";
import {
  hashOperatorAccessToken,
  operatorAccessTokenPattern,
} from "../../operator-access";
import { repository } from "../../repository";
import { AccessForm } from "./access-form";
import styles from "./join.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = operatorAccessTokenPattern.test(token)
    ? await repository.operatorAccessLink(
        process.env.HOT_POTATO_ORG ?? "acme",
        hashOperatorAccessToken(token),
      )
    : null;

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="access-title">
        <div className={styles.brand}>
          <img src="/hot-potato-mascot.png" alt="" />
          <span>HOT POTATO</span>
        </div>
        <p className={styles.eyebrow}>
          {access?.purpose === "password_reset"
            ? "SECURE PASSWORD RESET"
            : "WORKSPACE INVITATION"}
        </p>
        <h1 id="access-title">
          {access
            ? access.purpose === "invite"
              ? `Join ${access.organizationName}.`
              : "Choose a new password."
            : "This link is no longer active."}
        </h1>
        <p className={styles.intro}>
          {access
            ? access.purpose === "invite"
              ? "Create your private operator credential. The link works once and your password never appears in the workspace."
              : "Finishing this reset revokes your other Hot Potato sessions and signs you in here."
            : "It may have expired, already been used, or been revoked. Ask a workspace admin for a fresh link."}
        </p>
        {access ? (
          <AccessForm
            token={token}
            purpose={access.purpose}
            displayName={access.displayName}
            login={access.login}
          />
        ) : (
          <a className={styles.loginLink} href="/login">
            Return to sign in <span aria-hidden="true">↗</span>
          </a>
        )}
      </section>
      <aside className={styles.promise} aria-label="Access promise">
        <span>ONE PERSON · ONE LOGIN</span>
        <blockquote>
          No recycled setup password. No mystery access. Every session can be
          seen and revoked.
        </blockquote>
        <p>Named membership · Scoped roles · Self-hosted control</p>
      </aside>
    </main>
  );
}
