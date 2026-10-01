import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.brand}>
          <img src="/hot-potato-mascot.png" alt="" />
          <span>HOT POTATO</span>
        </div>
        <p className={styles.eyebrow}>OPERATOR WORKSPACE</p>
        <h1 id="login-title">Route the lead. Keep the context.</h1>
        <p className={styles.intro}>
          Sign in with the named owner account configured by this Hot Potato
          deployment. Your session is revocable and scoped to one workspace.
        </p>
        <LoginForm />
        <p className={styles.setup}>
          First run? Set <code>HOT_POTATO_ADMIN_USER</code> and{" "}
          <code>HOT_POTATO_ADMIN_PASSWORD</code>, then rerun bootstrap.
        </p>
      </section>
      <aside className={styles.promise} aria-label="Product promise">
        <span>NO BLACK BOX</span>
        <blockquote>
          Explainable routing, live Google and Outlook availability, and a
          booking lifecycle your team controls.
        </blockquote>
        <p>Open source · Self-hosted · Built for operators</p>
      </aside>
    </main>
  );
}
