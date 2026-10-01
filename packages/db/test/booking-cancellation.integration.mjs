import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "../dist/client.js";
import { HotPotatoRepository } from "../dist/repository.js";
// This suite writes fictional rows and installs a fixture-scoped fault trigger.
// Never point it at a shared, development, or production database.
assert.equal(
  process.env.HOT_POTATO_DISPOSABLE_DB,
  "1",
  "Set HOT_POTATO_DISPOSABLE_DB=1 only for an isolated disposable test database.",
);
assert(
  process.env.DATABASE_URL,
  "DATABASE_URL must explicitly name the disposable test database.",
);
const target = new URL(process.env.DATABASE_URL);
assert(
  ["postgres:", "postgresql:"].includes(target.protocol),
  "Use a PostgreSQL URL.",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname),
  "Test database must be loopback-only.",
);
assert(
  /_(ci|test)$/.test(decodeURIComponent(target.pathname.slice(1))),
  "Disposable database name must end in _ci or _test.",
);
const sql = createDatabase(target.toString());
const repository = new HotPotatoRepository(sql);
const observer = createDatabase(target.toString());
const orgs = [];
const results = [];
async function fixture({ uncertain = false, cutoff = null } = {}) {
  const token = randomUUID();
  const hash = createHash("sha256").update(token).digest("hex");
  const [org] =
    await sql`INSERT INTO organizations(slug,name) VALUES (${`qa-${token}`}, 'Fictional QA') RETURNING id`;
  orgs.push(org.id);
  const [rep] =
    await sql`INSERT INTO reps(organization_id,name,email,active_calendar_provider,scheduling_slug) VALUES (${org.id}, 'Fictional QA', 'qa@example.test', 'google','qa') RETURNING id`;
  await sql`INSERT INTO rep_calendar_connections(rep_id,provider,encrypted_access_token,encrypted_refresh_token,expires_at,external_account_id) VALUES (${rep.id}, 'google', 'fictional', 'fictional', '2035-01-01', ${token})`;
  const [meeting] =
    await sql`INSERT INTO meeting_types(organization_id,rep_id,slug,title) VALUES (${org.id},${rep.id},'qa','Fictional QA') RETURNING id`;
  const [booking] =
    await sql`INSERT INTO bookings(organization_id,meeting_type_id,rep_id,external_id,manage_token_hash,status,attendee_name,attendee_email,starts_at,ends_at,calendar_provider,calendar_external_account_id,external_event_id,last_error,previous_starts_at,previous_ends_at,cancel_cutoff_minutes) VALUES (${org.id},${meeting.id},${rep.id},${token},${hash},${uncertain ? "reschedule_pending" : "confirmed"},'Fictional QA','qa@example.test','2035-01-02T16:00:00Z','2035-01-02T16:30:00Z','google',${token},'qa-event',${uncertain ? "response lost" : null},${uncertain ? "2035-01-01T16:00:00Z" : null},${uncertain ? "2035-01-01T16:30:00Z" : null},${cutoff}) RETURNING id`;
  let updateId;
  if (uncertain) {
    const [update] =
      await sql`INSERT INTO jobs(organization_id,type,payload,status,attempts) VALUES (${org.id},'calendar.event.update',${sql.json({ bookingId: booking.id })},'failed',5) RETURNING id`;
    updateId = Number(update.id);
  }
  return {
    token,
    bookingId: booking.id,
    orgId: org.id,
    repId: rep.id,
    updateId,
  };
}
async function jobs(f) {
  return sql`SELECT id,type,status,claim_token FROM jobs WHERE payload->>'bookingId'=${f.bookingId} ORDER BY id`;
}
async function claim(id, attempts = 1) {
  const claim = randomUUID();
  await sql`UPDATE jobs SET status='processing',claim_token=${claim},attempts=${attempts} WHERE id=${id}`;
  return claim;
}
async function lockedBooking(f) {
  let release, locked;
  const ready = new Promise((resolve) => (locked = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const done = sql.begin(async (tx) => {
    await tx`SELECT id FROM bookings WHERE id=${f.bookingId} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  return { release, done };
}
async function waitBlocked(n = 1) {
  for (let i = 0; i < 100; i++) {
    const [{ count }] =
      await observer`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
    if (count >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected database lock contention did not occur");
}
async function test(name, fn) {
  await fn();
  results.push(name);
  console.log("PASS", name);
}
async function pendingRescheduleFixture() {
  const f = await fixture({ uncertain: true });
  await sql`UPDATE bookings SET last_error=null WHERE id=${f.bookingId}`;
  await sql`UPDATE jobs SET status='pending',attempts=0 WHERE id=${f.updateId}`;
  return {
    ...f,
    input: {
      manageToken: f.token,
      startsAt: new Date("2035-01-02T16:00:00Z"),
      endsAt: new Date("2035-01-02T16:30:00Z"),
      reminderMinutes: 0,
    },
  };
}

async function waitForSignal(signal, message) {
  let timer;
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Delay only the timing of a real SQL read. No query or database result is
// replaced. This makes the job-lock/booking-lock interleaving reproducible.
function repositoryWithGatedJobRead(reached, release) {
  return new HotPotatoRepository(
    new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "begin")
          return Reflect.get(target, property, receiver);
        return (run) =>
          target.begin((transaction) =>
            run(
              new Proxy(transaction, {
                apply(query, thisArg, args) {
                  const statement = Array.isArray(args[0])
                    ? args[0].join("?").replace(/\s+/g, " ").trim()
                    : "";
                  if (statement.startsWith("SELECT id, status FROM jobs")) {
                    reached.resolve();
                    return release.promise.then(() =>
                      Reflect.apply(query, thisArg, args),
                    );
                  }
                  return Reflect.apply(query, thisArg, args);
                },
              }),
            ),
          );
      },
    }),
  );
}
try {
  await test("20 concurrent same-token cancels: one durable cancel job and 20 pending acknowledgements", async () => {
    const f = await fixture();
    const lock = await lockedBooking(f);
    const pending = Array.from({ length: 20 }, () =>
      repository.requestBookingCancellation(f.token),
    );
    try {
      await waitBlocked(3);
    } finally {
      lock.release();
      await lock.done;
    }
    assert.deepEqual(
      await Promise.all(pending),
      Array(20).fill("cancel_pending"),
    );
    assert.equal(
      (await jobs(f)).filter((x) => x.type === "calendar.event.cancel").length,
      1,
    );
  });
  await test("repeated cancellation after disconnected account and passed cutoff is still acknowledged", async () => {
    const f = await fixture();
    await repository.requestBookingCancellation(f.token);
    await sql`DELETE FROM rep_calendar_connections WHERE rep_id=${f.repId}`;
    await sql`UPDATE bookings SET starts_at=now()-interval '2 hours', ends_at=now()-interval '1 hour',cancel_cutoff_minutes=0 WHERE id=${f.bookingId}`;
    assert.equal(
      await repository.requestBookingCancellation(f.token),
      "cancel_pending",
    );
    const [job] = await jobs(f);
    const claimToken = await claim(job.id);
    assert.equal(
      await repository.completeJob(Number(job.id), claimToken, {
        externalEventId: "qa-event",
      }),
      true,
    );
    assert.equal(
      await repository.requestBookingCancellation(f.token),
      "cancelled",
    );
    assert.equal(
      (await jobs(f)).filter((x) => x.type === "calendar.event.cancel").length,
      1,
    );
  });
  await test("worker completion interleaved with 8 retries never adds a second cancel job or notification", async () => {
    const f = await fixture();
    await repository.requestBookingCancellation(f.token);
    const [job] = await jobs(f);
    const claimToken = await claim(job.id);
    const lock = await lockedBooking(f);
    const completion = repository.completeJob(Number(job.id), claimToken, {
      externalEventId: "qa-event",
    });
    let retries;
    try {
      await waitBlocked();
      retries = Array.from({ length: 8 }, () =>
        repository.requestBookingCancellation(f.token),
      );
    } finally {
      lock.release();
      await lock.done;
    }
    assert.equal(await completion, true);
    const statuses = await Promise.all(retries);
    assert(statuses.every((x) => ["cancel_pending", "cancelled"].includes(x)));
    assert.equal(
      await repository.requestBookingCancellation(f.token),
      "cancelled",
    );
    const all = await jobs(f);
    assert.equal(
      all.filter((x) => x.type === "calendar.event.cancel").length,
      1,
    );
    assert.equal(
      all.filter((x) => x.type === "email.booking.cancelled").length,
      1,
    );
    assert.equal(
      await repository.completeJob(Number(job.id), claimToken, {
        externalEventId: "qa-event",
      }),
      false,
    );
  });
  await test("10 concurrent uncertain-reschedule cancellations preserve ranges and cancel only one update job", async () => {
    const f = await fixture({ uncertain: true });
    const result = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.requestBookingCancellation(f.token),
      ),
    );
    assert(result.every((x) => x === "cancel_pending"));
    const all = await jobs(f);
    assert.equal(
      all.filter((x) => x.type === "calendar.event.cancel").length,
      1,
    );
    assert.equal(
      all.find((x) => Number(x.id) === f.updateId).status,
      "cancelled",
    );
    const [booking] =
      await sql`SELECT status,previous_starts_at FROM bookings WHERE id=${f.bookingId}`;
    assert.equal(booking.status, "cancel_pending");
    assert(booking.previousStartsAt);
    const cancel = all.find((x) => x.type === "calendar.event.cancel");
    const claimToken = await claim(cancel.id);
    await repository.completeJob(Number(cancel.id), claimToken, {
      externalEventId: "qa-event",
    });
    const [done] =
      await sql`SELECT status,previous_starts_at FROM bookings WHERE id=${f.bookingId}`;
    assert.equal(done.status, "cancelled");
    assert.equal(done.previousStartsAt, null);
  });
  await test("terminal failed uncertain cancellation restores retry state; next accepted request has one new active job", async () => {
    const f = await fixture({ uncertain: true });
    await repository.requestBookingCancellation(f.token);
    const cancel = (await jobs(f)).find(
      (x) => x.type === "calendar.event.cancel",
    );
    const claimToken = await claim(cancel.id, 5);
    assert.equal(
      await repository.failJob(
        Number(cancel.id),
        claimToken,
        "fictional provider unavailable",
      ),
      true,
    );
    const [booking] =
      await sql`SELECT status FROM bookings WHERE id=${f.bookingId}`;
    assert.equal(booking.status, "reschedule_pending");
    assert.equal(
      (await jobs(f)).find((x) => Number(x.id) === f.updateId).status,
      "failed",
    );
    assert.equal(
      await repository.requestBookingCancellation(f.token),
      "cancel_pending",
    );
    assert.equal(
      (await jobs(f)).filter(
        (x) => x.type === "calendar.event.cancel" && x.status === "pending",
      ).length,
      1,
    );
  });
  await test("job insertion failure rolls back cancellation status and permits retry", async () => {
    const f = await fixture();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `qa_block_cancel_${suffix}`;
    const triggerName = `qa_block_cancel_${suffix}`;
    // PostgreSQL utility statements cannot bind trigger arguments. The organization
    // ID came from this test's INSERT; validate it before embedding the literal.
    assert.match(
      f.orgId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type='calendar.event.cancel' AND NEW.organization_id::text=TG_ARGV[0] THEN
          RAISE EXCEPTION 'fictional job storage failure';
        END IF;
        RETURN NEW;
      END $$;`);
    try {
      await sql.unsafe(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ${functionName}('${f.orgId}');`,
      );
      try {
        // A separate fictional organization is unaffected by the injected failure.
        const other = await fixture();
        assert.equal(
          await repository.requestBookingCancellation(other.token),
          "cancel_pending",
        );
        await assert.rejects(
          repository.requestBookingCancellation(f.token),
          /fictional job storage failure/,
        );
      } finally {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON jobs;`);
      }
    } finally {
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}();`);
    }
    const [booking] =
      await sql`SELECT status FROM bookings WHERE id=${f.bookingId}`;
    assert.equal(booking.status, "confirmed");
    assert.equal((await jobs(f)).length, 0);
    assert.equal(
      await repository.requestBookingCancellation(f.token),
      "cancel_pending",
    );
  });
  await test("20 repeated pending reschedules acknowledge the accepted time without another job or connected account", async () => {
    const f = await pendingRescheduleFixture();
    await sql`DELETE FROM rep_calendar_connections WHERE rep_id=${f.repId}`;
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.requestBookingReschedule(f.input),
      ),
    );
    assert.deepEqual(statuses, Array(20).fill("reschedule_pending"));
    assert.equal(
      (await jobs(f)).filter((job) => job.type === "calendar.event.update")
        .length,
      1,
    );
  });
  await test("an exact reschedule retry and worker completion use compatible locks and create no duplicate job or notification", async () => {
    const f = await pendingRescheduleFixture();
    const claimToken = await claim(f.updateId);
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    const gatedRepository = repositoryWithGatedJobRead(reached, release);
    const repeated = gatedRepository.requestBookingReschedule(f.input).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let completion;
    try {
      await waitForSignal(
        reached.promise,
        "Reschedule acknowledgement never reached its real job read.",
      );
      // The retry owns the booking lock. The worker takes the job lock and
      // then blocks on that booking, reproducing the formerly inverted order.
      completion = repository.completeJob(f.updateId, claimToken, {
        externalEventId: "qa-event",
      });
      await waitBlocked();
    } finally {
      release.resolve();
    }
    const [retryResult, completed] = await Promise.all([repeated, completion]);
    assert.ifError(retryResult.error);
    assert.equal(retryResult.value, "reschedule_pending");
    assert.equal(completed, true);
    assert.equal(
      await repository.requestBookingReschedule(f.input),
      "confirmed",
    );
    const [booking] =
      await sql`SELECT status,starts_at,ends_at,previous_starts_at,previous_ends_at FROM bookings WHERE id=${f.bookingId}`;
    assert.equal(booking.status, "confirmed");
    assert.equal(
      new Date(booking.startsAt).getTime(),
      f.input.startsAt.getTime(),
    );
    assert.equal(new Date(booking.endsAt).getTime(), f.input.endsAt.getTime());
    assert.equal(booking.previousStartsAt, null);
    assert.equal(booking.previousEndsAt, null);
    const all = await jobs(f);
    assert.equal(
      all.filter((job) => job.type === "calendar.event.update").length,
      1,
    );
    assert.equal(
      all.filter((job) => job.type === "email.booking.rescheduled").length,
      1,
    );
  });
  console.log(
    JSON.stringify(
      {
        passed: results.length,
        tests: results,
        scope:
          "Real PostgreSQL with current built repository and migrations, isolated fictional database; provider calls are not exercised",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    for (const id of orgs) await sql`DELETE FROM organizations WHERE id=${id}`;
  } finally {
    await Promise.all([sql.end(), observer.end()]);
  }
}
