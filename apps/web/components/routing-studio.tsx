"use client";

import type { Dashboard, RoutingPreview } from "@hot-potato/db";
import { useEffect, useMemo, useState, type FormEvent } from "react";

type RuleOperator =
  RoutingPreview["rules"][number]["conditions"][number]["operator"];

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

type RepDraft = {
  clientKey: string;
  id?: string;
  name: string;
  email: string;
  schedulingSlug: string;
  timezone: string;
  weight: number;
  active: boolean;
};

type PoolDraft = {
  clientKey: string;
  id?: string;
  name: string;
  slug: string;
  memberIds: string[];
};

type ConditionDraft = {
  clientKey: string;
  field: string;
  operator: RuleOperator;
  value: string;
};

type RuleDraft = {
  clientKey: string;
  id?: string;
  name: string;
  priority: number;
  poolId: string;
  active: boolean;
  catchAll: boolean;
  conditions: ConditionDraft[];
};

const operators: Array<{ value: RuleOperator; label: string }> = [
  { value: "eq", label: "is exactly" },
  { value: "in", label: "is one of" },
  { value: "gte", label: "is at least" },
  { value: "lte", label: "is at most" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "is present" },
];

const knownTimezones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Australia/Sydney",
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function createClientKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRepDrafts(reps: Dashboard["reps"]): RepDraft[] {
  return reps.map((rep) => ({
    clientKey: `rep-${rep.id}`,
    id: rep.id,
    name: rep.name,
    email: rep.email,
    schedulingSlug: rep.schedulingSlug,
    timezone: rep.timezone,
    weight: rep.weight,
    active: rep.active,
  }));
}

function toPoolDrafts(pools: Dashboard["pools"]): PoolDraft[] {
  return pools.map((pool) => ({
    clientKey: `pool-${pool.id}`,
    id: pool.id,
    name: pool.name,
    slug: pool.slug,
    memberIds: pool.members.map((member) => member.id),
  }));
}

function isRuleOperator(value: string): value is RuleOperator {
  return operators.some((operator) => operator.value === value);
}

function formatConditionValue(value: unknown, operator: RuleOperator): string {
  if (operator === "in" && Array.isArray(value)) return value.join(", ");
  if (operator === "exists") return value === false ? "false" : "true";
  if (value === undefined || value === null) return "";
  return String(value);
}

function toConditionDrafts(
  conditions: Record<string, unknown>,
  ruleId: string,
): ConditionDraft[] {
  return Object.entries(conditions).map(([field, rawPredicate], index) => {
    const predicate =
      rawPredicate && typeof rawPredicate === "object"
        ? (rawPredicate as Record<string, unknown>)
        : {};
    const operator =
      Object.keys(predicate).find(isRuleOperator) ?? ("eq" as const);
    return {
      clientKey: `${ruleId}-${field}-${index}`,
      field,
      operator,
      value: formatConditionValue(predicate[operator], operator),
    };
  });
}

function toRuleDrafts(rules: Dashboard["rules"]): RuleDraft[] {
  return rulesInEvaluationOrder(
    rules.map((rule) => ({
      clientKey: `rule-${rule.id}`,
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      poolId: rule.poolId,
      active: rule.active,
      catchAll: Object.keys(rule.conditions).length === 0,
      conditions: toConditionDrafts(rule.conditions, rule.id),
    })),
  );
}

function rulesInEvaluationOrder(rules: RuleDraft[]): RuleDraft[] {
  return [...rules].sort((left, right) => {
    const catchAllOrder = Number(left.catchAll) - Number(right.catchAll);
    if (catchAllOrder !== 0) return catchAllOrder;
    return left.priority - right.priority;
  });
}

function parseLiteral(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function conditionExpected(condition: ConditionDraft): unknown {
  if (condition.operator === "exists") return condition.value !== "false";
  if (condition.operator === "gte" || condition.operator === "lte") {
    return Number(condition.value);
  }
  if (condition.operator === "in") {
    return condition.value
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) =>
        /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : value,
      );
  }
  return parseLiteral(condition.value);
}

function serializeConditions(
  conditions: ConditionDraft[],
): Record<string, unknown> {
  return Object.fromEntries(
    conditions.map((condition) => [
      condition.field.trim(),
      { [condition.operator]: conditionExpected(condition) },
    ]),
  );
}

function isSafeFieldPath(field: string): boolean {
  const parts = field.split(".");
  return (
    parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) &&
    parts.every(
      (part) =>
        part !== "__proto__" && part !== "prototype" && part !== "constructor",
    )
  );
}

function fieldLabel(field: string): string {
  return field
    .split(".")
    .at(-1)!
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTraceValue(value: unknown): string {
  if (value === undefined) return "Not provided";
  if (value === null) return "None";
  if (typeof value === "string") return value || "Empty";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatEvaluatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function nextWeekdayMorning(): string {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(10, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() + 1);
  }
  const local = new Date(
    candidate.getTime() - candidate.getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}

function setNestedValue(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const keys = path.split(".");
  let cursor = target;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      cursor[key] = value;
      return;
    }
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  });
}

async function responseMessage(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" ? body.error : null;
}

function InlineNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      className={`studio-notice ${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.message}
    </p>
  );
}

export function RoutingStudio({
  dashboard,
  onRefresh,
}: {
  dashboard: Dashboard;
  onRefresh: () => Promise<void>;
}) {
  const [repDrafts, setRepDrafts] = useState<RepDraft[]>(() =>
    toRepDrafts(dashboard.reps),
  );
  const [poolDrafts, setPoolDrafts] = useState<PoolDraft[]>(() =>
    toPoolDrafts(dashboard.pools),
  );
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>(() =>
    toRuleDrafts(dashboard.rules),
  );
  const [savingRep, setSavingRep] = useState<string | null>(null);
  const [savingPool, setSavingPool] = useState<string | null>(null);
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [repNotice, setRepNotice] = useState<Notice | null>(null);
  const [poolNotice, setPoolNotice] = useState<Notice | null>(null);
  const [ruleNotice, setRuleNotice] = useState<Notice | null>(null);
  const [previewNotice, setPreviewNotice] = useState<Notice | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [previewAt, setPreviewAt] = useState(nextWeekdayMorning);

  useEffect(() => setRepDrafts(toRepDrafts(dashboard.reps)), [dashboard.reps]);
  useEffect(
    () => setPoolDrafts(toPoolDrafts(dashboard.pools)),
    [dashboard.pools],
  );
  useEffect(
    () => setRuleDrafts(toRuleDrafts(dashboard.rules)),
    [dashboard.rules],
  );

  const savedPreviewConditions = useMemo(
    () =>
      dashboard.rules
        .filter((rule) => rule.active)
        .flatMap((rule) =>
          toConditionDrafts(rule.conditions, `preview-${rule.id}`),
        ),
    [dashboard.rules],
  );

  const previewFields = useMemo(() => {
    const fields = new Set<string>(["email", "current_owner_email"]);
    for (const condition of savedPreviewConditions) {
      const field = condition.field.trim();
      if (isSafeFieldPath(field)) fields.add(field);
    }
    return [...fields];
  }, [savedPreviewConditions]);

  const previewFieldSignature = previewFields.join("|");
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({
    email: "lead@example.com",
    current_owner_email: "",
  });

  useEffect(() => {
    setPreviewValues((current) =>
      Object.fromEntries(
        previewFields.map((field) => [
          field,
          current[field] ?? (field === "email" ? "lead@example.com" : ""),
        ]),
      ),
    );
    // A signature keeps the effect stable while the rule editor changes values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFieldSignature]);

  function updateRep(index: number, changes: Partial<RepDraft>) {
    setRepDrafts((current) =>
      current.map((rep, repIndex) =>
        repIndex === index ? { ...rep, ...changes } : rep,
      ),
    );
  }

  function addRep() {
    setRepDrafts((current) => [
      ...current,
      {
        clientKey: createClientKey("rep"),
        name: "New representative",
        email: "",
        schedulingSlug: "new-representative",
        timezone: "America/New_York",
        weight: 1,
        active: true,
      },
    ]);
    setRepNotice({
      tone: "info",
      message:
        "New representative added locally. Complete the fields and save.",
    });
  }

  async function saveRep(index: number) {
    const rep = repDrafts[index];
    if (!rep) return;
    if (!rep.name.trim() || !rep.email.trim() || !rep.timezone.trim()) {
      setRepNotice({
        tone: "error",
        message: "Name, email, and timezone are required.",
      });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rep.email)) {
      setRepNotice({ tone: "error", message: "Enter a valid email address." });
      return;
    }
    if (
      !rep.schedulingSlug ||
      slugify(rep.schedulingSlug) !== rep.schedulingSlug
    ) {
      setRepNotice({
        tone: "error",
        message:
          "The scheduling slug must contain letters, numbers, and hyphens.",
      });
      return;
    }
    if (!Number.isInteger(rep.weight) || rep.weight < 1) {
      setRepNotice({
        tone: "error",
        message: "Weight must be a whole number of at least 1.",
      });
      return;
    }

    setSavingRep(rep.clientKey);
    setRepNotice(null);
    try {
      const response = await fetch("/api/settings/reps", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(rep.id ? { id: rep.id } : {}),
          name: rep.name.trim(),
          email: rep.email.trim(),
          schedulingSlug: rep.schedulingSlug,
          timezone: rep.timezone.trim(),
          weight: rep.weight,
          active: rep.active,
        }),
      });
      if (!response.ok) {
        setRepNotice({
          tone: "error",
          message:
            (await responseMessage(response)) ??
            "The representative could not be saved.",
        });
        return;
      }
      setRepNotice({
        tone: "success",
        message: `${rep.name.trim()} saved. Future routes will use the updated representative settings.`,
      });
      try {
        await onRefresh();
      } catch {
        setRepNotice({
          tone: "info",
          message: `${rep.name.trim()} was saved, but the workspace could not refresh. Reload to see the latest settings.`,
        });
      }
    } catch {
      setRepNotice({
        tone: "error",
        message:
          "The representative could not be saved. Check the connection and try again.",
      });
    } finally {
      setSavingRep(null);
    }
  }

  function updatePool(index: number, changes: Partial<PoolDraft>) {
    setPoolDrafts((current) =>
      current.map((pool, poolIndex) =>
        poolIndex === index ? { ...pool, ...changes } : pool,
      ),
    );
  }

  function togglePoolMember(index: number, repId: string, checked: boolean) {
    const pool = poolDrafts[index];
    if (!pool) return;
    updatePool(index, {
      memberIds: checked
        ? [...new Set([...pool.memberIds, repId])]
        : pool.memberIds.filter((memberId) => memberId !== repId),
    });
  }

  function addPool() {
    setPoolDrafts((current) => [
      ...current,
      {
        clientKey: createClientKey("pool"),
        name: "New pool",
        slug: "new-pool",
        memberIds: [],
      },
    ]);
    setPoolNotice({
      tone: "info",
      message:
        "New pool added locally. Choose at least one representative and save.",
    });
  }

  async function savePool(index: number) {
    const pool = poolDrafts[index];
    if (!pool) return;
    if (!pool.name.trim() || !pool.slug) {
      setPoolNotice({
        tone: "error",
        message: "Pool name and slug are required.",
      });
      return;
    }
    if (slugify(pool.slug) !== pool.slug) {
      setPoolNotice({
        tone: "error",
        message: "The pool slug must contain letters, numbers, and hyphens.",
      });
      return;
    }
    if (pool.memberIds.length === 0) {
      setPoolNotice({
        tone: "error",
        message: "Choose at least one representative before saving the pool.",
      });
      return;
    }

    setSavingPool(pool.clientKey);
    setPoolNotice(null);
    try {
      const response = await fetch("/api/settings/pools", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(pool.id ? { id: pool.id } : {}),
          name: pool.name.trim(),
          slug: pool.slug,
          memberIds: pool.memberIds,
        }),
      });
      if (!response.ok) {
        setPoolNotice({
          tone: "error",
          message:
            (await responseMessage(response)) ?? "The pool could not be saved.",
        });
        return;
      }
      setPoolNotice({
        tone: "success",
        message: `${pool.name.trim()} saved with ${pool.memberIds.length} representative${pool.memberIds.length === 1 ? "" : "s"}.`,
      });
      try {
        await onRefresh();
      } catch {
        setPoolNotice({
          tone: "info",
          message: `${pool.name.trim()} was saved, but the workspace could not refresh. Reload to see the latest settings.`,
        });
      }
    } catch {
      setPoolNotice({
        tone: "error",
        message:
          "The pool could not be saved. Check the connection and try again.",
      });
    } finally {
      setSavingPool(null);
    }
  }

  function updateRule(index: number, changes: Partial<RuleDraft>) {
    setRuleDrafts((current) =>
      current.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...changes } : rule,
      ),
    );
  }

  function updateCondition(
    ruleIndex: number,
    conditionIndex: number,
    changes: Partial<ConditionDraft>,
  ) {
    const rule = ruleDrafts[ruleIndex];
    if (!rule) return;
    updateRule(ruleIndex, {
      conditions: rule.conditions.map((condition, index) =>
        index === conditionIndex ? { ...condition, ...changes } : condition,
      ),
    });
  }

  function addCondition(ruleIndex: number) {
    const rule = ruleDrafts[ruleIndex];
    if (!rule) return;
    updateRule(ruleIndex, {
      conditions: [
        ...rule.conditions,
        {
          clientKey: createClientKey("condition"),
          field: "company.employee_count",
          operator: "gte",
          value: "100",
        },
      ],
    });
  }

  function removeCondition(ruleIndex: number, conditionIndex: number) {
    const rule = ruleDrafts[ruleIndex];
    if (!rule || rule.conditions.length === 1) return;
    updateRule(ruleIndex, {
      conditions: rule.conditions.filter(
        (_, index) => index !== conditionIndex,
      ),
    });
  }

  function addRule() {
    const nextPriority =
      ruleDrafts.reduce(
        (highest, rule) => Math.max(highest, rule.priority),
        0,
      ) + 1;
    setRuleDrafts((current) => [
      ...current,
      {
        clientKey: createClientKey("rule"),
        name: "New routing rule",
        priority: nextPriority,
        poolId: poolDrafts[0]?.id ?? "",
        active: true,
        catchAll: false,
        conditions: [
          {
            clientKey: createClientKey("condition"),
            field: "company.employee_count",
            operator: "gte",
            value: "100",
          },
        ],
      },
    ]);
    setRuleNotice({
      tone: "info",
      message:
        "New conditional rule added locally. Conditional rules are evaluated from lowest priority number to highest.",
    });
  }

  function addCatchAll() {
    const existing = ruleDrafts.find((rule) => rule.catchAll);
    if (existing) {
      setRuleNotice({
        tone: "info",
        message: `${existing.name || "The existing catch-all"} already handles every lead not matched earlier.`,
      });
      return;
    }
    const nextPriority =
      ruleDrafts.reduce(
        (highest, rule) => Math.max(highest, rule.priority),
        0,
      ) + 1;
    setRuleDrafts((current) => [
      ...current,
      {
        clientKey: createClientKey("catch-all"),
        name: "Every other qualified lead",
        priority: nextPriority,
        poolId: poolDrafts[0]?.id ?? "",
        active: true,
        catchAll: true,
        conditions: [],
      },
    ]);
    setRuleNotice({
      tone: "info",
      message:
        "Catch-all added locally. It always evaluates after every conditional rule, regardless of priority.",
    });
  }

  function validateRule(rule: RuleDraft): string | null {
    if (!rule.name.trim()) return "Rule name is required.";
    if (!Number.isInteger(rule.priority) || rule.priority < 1) {
      return "Priority must be a whole number of at least 1.";
    }
    if (!rule.poolId) return "Choose a destination pool.";
    if (!rule.catchAll && rule.conditions.length === 0) {
      return "Add at least one condition.";
    }
    const fields = rule.conditions.map((condition) => condition.field.trim());
    if (fields.some((field) => !isSafeFieldPath(field))) {
      return "Condition fields must use dot-separated letters, numbers, and underscores.";
    }
    if (new Set(fields).size !== fields.length) {
      return "Each field can appear only once in a rule.";
    }
    for (const condition of rule.conditions) {
      if (condition.operator !== "exists" && !condition.value.trim()) {
        return `Enter a value for ${fieldLabel(condition.field)}.`;
      }
      if (
        (condition.operator === "gte" || condition.operator === "lte") &&
        !Number.isFinite(Number(condition.value))
      ) {
        return `${fieldLabel(condition.field)} needs a numeric value.`;
      }
      if (
        condition.operator === "in" &&
        condition.value.split(",").every((value) => !value.trim())
      ) {
        return `${fieldLabel(condition.field)} needs at least one comma-separated value.`;
      }
    }
    return null;
  }

  async function saveRule(index: number) {
    const rule = ruleDrafts[index];
    if (!rule) return;
    const validationError = validateRule(rule);
    if (validationError) {
      setRuleNotice({ tone: "error", message: validationError });
      return;
    }

    setSavingRule(rule.clientKey);
    setRuleNotice(null);
    try {
      const response = await fetch("/api/settings/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(rule.id ? { id: rule.id } : {}),
          name: rule.name.trim(),
          priority: rule.priority,
          poolId: rule.poolId,
          active: rule.active,
          catchAll: rule.catchAll,
          conditions: serializeConditions(rule.conditions),
        }),
      });
      if (!response.ok) {
        setRuleNotice({
          tone: "error",
          message:
            (await responseMessage(response)) ?? "The rule could not be saved.",
        });
        return;
      }
      setRuleNotice({
        tone: "success",
        message: rule.catchAll
          ? `${rule.name.trim()} saved as the final catch-all.`
          : `${rule.name.trim()} saved at priority ${rule.priority}.`,
      });
      try {
        await onRefresh();
      } catch {
        setRuleNotice({
          tone: "info",
          message: `${rule.name.trim()} was saved, but the workspace could not refresh. Reload to see the latest settings.`,
        });
      }
    } catch {
      setRuleNotice({
        tone: "error",
        message:
          "The rule could not be saved. Check the connection and try again.",
      });
    } finally {
      setSavingRule(null);
    }
  }

  function fieldInputKind(field: string): "text" | "number" | "boolean" {
    const conditions = savedPreviewConditions.filter(
      (condition) => condition.field.trim() === field,
    );
    if (
      conditions.some(
        (condition) =>
          condition.operator === "gte" || condition.operator === "lte",
      )
    ) {
      return "number";
    }
    const expected = conditions.map(conditionExpected);
    if (
      conditions.some(
        (condition, index) =>
          condition.operator === "eq" && typeof expected[index] === "boolean",
      )
    ) {
      return "boolean";
    }
    if (
      expected.length > 0 &&
      expected.every(
        (value) =>
          typeof value === "number" ||
          (Array.isArray(value) &&
            value.length > 0 &&
            value.every((item) => typeof item === "number")),
      )
    ) {
      return "number";
    }
    return "text";
  }

  function previewPlaceholder(field: string): string {
    const examples = savedPreviewConditions
      .filter((condition) => condition.field.trim() === field)
      .map((condition) => condition.value)
      .filter(Boolean);
    return examples[0] ? `Rule value: ${examples[0]}` : "Optional";
  }

  async function runPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = previewValues.email?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setPreviewNotice({
        tone: "error",
        message: "Enter a valid lead email before testing the route.",
      });
      return;
    }
    const evaluatedAt = new Date(previewAt);
    if (Number.isNaN(evaluatedAt.getTime())) {
      setPreviewNotice({
        tone: "error",
        message: "Choose a valid date and time for the route preview.",
      });
      return;
    }

    const lead: Record<string, unknown> = {};
    for (const field of previewFields) {
      const rawValue = previewValues[field]?.trim() ?? "";
      if (!rawValue) continue;
      const kind = fieldInputKind(field);
      const value =
        kind === "number"
          ? Number(rawValue)
          : kind === "boolean"
            ? rawValue === "true"
            : rawValue;
      setNestedValue(lead, field, value);
    }

    setPreviewing(true);
    setPreview(null);
    setPreviewNotice(null);
    try {
      const response = await fetch("/api/settings/routing-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead, evaluatedAt: evaluatedAt.toISOString() }),
      });
      if (!response.ok) {
        setPreviewNotice({
          tone: "error",
          message:
            (await responseMessage(response)) ??
            "The route preview could not be evaluated.",
        });
        return;
      }
      const body = (await response.json()) as RoutingPreview;
      setPreview(body);
      setPreviewNotice({
        tone: "success",
        message:
          body.outcome === "matched"
            ? "Preview complete. No assignment counters, jobs, CRM records, or calendars were changed."
            : "Preview complete. The trace below explains why no representative was selected.",
      });
    } catch {
      setPreviewNotice({
        tone: "error",
        message:
          "The route preview could not be evaluated. Check the connection and try again.",
      });
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div
      className="routing-studio"
      id="routing-studio"
      aria-label="Routing Studio"
    >
      <section className="studio-section" id="reps">
        <div className="card-heading">
          <div>
            <span className="section-number">03</span>
            <div>
              <h2>Representatives</h2>
              <p>Add route owners and control their share of new leads.</p>
            </div>
          </div>
          <button type="button" onClick={addRep}>
            Add representative
          </button>
        </div>
        <InlineNotice notice={repNotice} />
        <datalist id="routing-timezone-options">
          {knownTimezones.map((timezone) => (
            <option value={timezone} key={timezone} />
          ))}
        </datalist>
        <div className="studio-card-list representative-editors">
          {repDrafts.map((rep, index) => (
            <article className="studio-editor" key={rep.clientKey}>
              <div className="studio-editor-heading">
                <div>
                  <span
                    className={rep.active ? "studio-live" : "studio-paused"}
                  >
                    {rep.active ? "ACTIVE" : "PAUSED"}
                  </span>
                  <h3>{rep.name || "Unnamed representative"}</h3>
                </div>
                <label className="studio-toggle">
                  <input
                    type="checkbox"
                    checked={rep.active}
                    onChange={(event) =>
                      updateRep(index, { active: event.target.checked })
                    }
                  />
                  Active for routing
                </label>
              </div>
              <div className="studio-field-grid">
                <label>
                  Name
                  <input
                    value={rep.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      updateRep(index, {
                        name,
                        ...(!rep.id ? { schedulingSlug: slugify(name) } : {}),
                      });
                    }}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={rep.email}
                    onChange={(event) =>
                      updateRep(index, { email: event.target.value })
                    }
                  />
                </label>
                <label>
                  Scheduling slug
                  <input
                    value={rep.schedulingSlug}
                    onChange={(event) =>
                      updateRep(index, {
                        schedulingSlug: slugify(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Timezone
                  <input
                    list="routing-timezone-options"
                    value={rep.timezone}
                    onChange={(event) =>
                      updateRep(index, { timezone: event.target.value })
                    }
                  />
                </label>
                <label>
                  Assignment weight
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={rep.weight}
                    onChange={(event) =>
                      updateRep(index, { weight: Number(event.target.value) })
                    }
                  />
                  <small>2 receives roughly twice the share of 1.</small>
                </label>
              </div>
              <div className="studio-editor-actions">
                <button
                  type="button"
                  className="studio-save"
                  disabled={savingRep === rep.clientKey}
                  onClick={() => void saveRep(index)}
                >
                  {savingRep === rep.clientKey
                    ? "Saving…"
                    : "Save representative"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="studio-section" id="pools">
        <div className="card-heading">
          <div>
            <span className="section-number">04</span>
            <div>
              <h2>Routing pools</h2>
              <p>Group the people who can receive the same kind of lead.</p>
            </div>
          </div>
          <button type="button" onClick={addPool}>
            Add pool
          </button>
        </div>
        <InlineNotice notice={poolNotice} />
        <div className="studio-card-list pool-editors">
          {poolDrafts.map((pool, index) => (
            <article className="studio-editor" key={pool.clientKey}>
              <div className="studio-editor-heading">
                <div>
                  <span className="studio-kicker">
                    {pool.memberIds.length} MEMBER
                    {pool.memberIds.length === 1 ? "" : "S"}
                  </span>
                  <h3>{pool.name || "Unnamed pool"}</h3>
                </div>
              </div>
              <div className="studio-field-grid two-column">
                <label>
                  Pool name
                  <input
                    value={pool.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      updatePool(index, {
                        name,
                        ...(!pool.id ? { slug: slugify(name) } : {}),
                      });
                    }}
                  />
                </label>
                <label>
                  Pool slug
                  <input
                    value={pool.slug}
                    onChange={(event) =>
                      updatePool(index, { slug: slugify(event.target.value) })
                    }
                  />
                </label>
              </div>
              <fieldset className="pool-members">
                <legend>Representatives in this pool</legend>
                <div>
                  {repDrafts
                    .filter((rep): rep is RepDraft & { id: string } =>
                      Boolean(rep.id),
                    )
                    .map((rep) => (
                      <label key={rep.id}>
                        <input
                          type="checkbox"
                          checked={pool.memberIds.includes(rep.id)}
                          onChange={(event) =>
                            togglePoolMember(
                              index,
                              rep.id,
                              event.target.checked,
                            )
                          }
                        />
                        <span>
                          <b>{rep.name}</b>
                          <small>
                            {rep.email} · {rep.active ? "Active" : "Paused"}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
              </fieldset>
              <div className="studio-editor-actions">
                <button
                  type="button"
                  className="studio-save"
                  disabled={savingPool === pool.clientKey}
                  onClick={() => void savePool(index)}
                >
                  {savingPool === pool.clientKey ? "Saving…" : "Save pool"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="studio-section" id="rules">
        <div className="card-heading">
          <div>
            <span className="section-number">05</span>
            <div>
              <h2>Ordered rules</h2>
              <p>
                Conditional rules run by priority. One catch-all can safely
                handle everyone else.
              </p>
            </div>
          </div>
          <div className="studio-heading-actions">
            <button
              type="button"
              onClick={addRule}
              disabled={poolDrafts.length === 0}
            >
              Add conditional rule
            </button>
            <button
              type="button"
              className="studio-secondary-action"
              onClick={addCatchAll}
              disabled={
                poolDrafts.length === 0 ||
                ruleDrafts.some((rule) => rule.catchAll)
              }
            >
              Add catch-all
            </button>
          </div>
        </div>
        <InlineNotice notice={ruleNotice} />
        <div className="studio-card-list rule-editors">
          {rulesInEvaluationOrder(ruleDrafts).map((rule) => {
            const index = ruleDrafts.findIndex(
              (candidate) => candidate.clientKey === rule.clientKey,
            );
            return (
              <article
                className="studio-editor rule-editor"
                key={rule.clientKey}
              >
                <div className="studio-editor-heading">
                  <div className="rule-title-block">
                    <span
                      className={`rule-order${rule.catchAll ? " catch-all" : ""}`}
                    >
                      {rule.catchAll ? "LAST" : `P${rule.priority}`}
                    </span>
                    <div>
                      <span
                        className={
                          rule.active ? "studio-live" : "studio-paused"
                        }
                      >
                        {rule.active ? "ACTIVE" : "PAUSED"}
                      </span>
                      <h3>{rule.name || "Unnamed rule"}</h3>
                    </div>
                  </div>
                  <label className="studio-toggle">
                    <input
                      type="checkbox"
                      checked={rule.active}
                      onChange={(event) =>
                        updateRule(index, { active: event.target.checked })
                      }
                    />
                    {rule.catchAll ? "Active catch-all" : "Active rule"}
                  </label>
                </div>
                <div className="studio-field-grid rule-settings">
                  <label>
                    Rule name
                    <input
                      value={rule.name}
                      onChange={(event) =>
                        updateRule(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    {rule.catchAll ? "Stored priority" : "Priority"}
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={rule.priority}
                      onChange={(event) =>
                        updateRule(index, {
                          priority: Number(event.target.value),
                        })
                      }
                    />
                    {rule.catchAll && (
                      <small>
                        Kept unique for audit history; catch-all always runs
                        last.
                      </small>
                    )}
                  </label>
                  <label>
                    {rule.catchAll
                      ? "Route every other lead to"
                      : "Route matching leads to"}
                    <select
                      value={rule.poolId}
                      onChange={(event) =>
                        updateRule(index, { poolId: event.target.value })
                      }
                    >
                      <option value="">Choose a pool</option>
                      {poolDrafts
                        .filter((pool): pool is PoolDraft & { id: string } =>
                          Boolean(pool.id),
                        )
                        .map((pool) => (
                          <option value={pool.id} key={pool.id}>
                            {pool.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {rule.catchAll ? (
                  <div className="catch-all-explainer">
                    <span aria-hidden="true">↳</span>
                    <div>
                      <b>No lead falls through the cracks</b>
                      <p>
                        This route has no conditions. It runs only after every
                        active conditional rule has been checked.
                      </p>
                    </div>
                  </div>
                ) : (
                  <fieldset className="rule-conditions">
                    <legend>All of these conditions</legend>
                    <div className="condition-list">
                      {rule.conditions.map((condition, conditionIndex) => (
                        <div
                          className="condition-row"
                          key={condition.clientKey}
                        >
                          <label>
                            Field
                            <input
                              aria-label={`Condition ${conditionIndex + 1} field`}
                              placeholder="company.employee_count"
                              value={condition.field}
                              onChange={(event) =>
                                updateCondition(index, conditionIndex, {
                                  field: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Operator
                            <select
                              aria-label={`Condition ${conditionIndex + 1} operator`}
                              value={condition.operator}
                              onChange={(event) => {
                                const operator = event.target
                                  .value as RuleOperator;
                                updateCondition(index, conditionIndex, {
                                  operator,
                                  ...(operator === "exists" && !condition.value
                                    ? { value: "true" }
                                    : {}),
                                });
                              }}
                            >
                              {operators.map((operator) => (
                                <option
                                  value={operator.value}
                                  key={operator.value}
                                >
                                  {operator.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Value
                            {condition.operator === "exists" ? (
                              <select
                                aria-label={`Condition ${conditionIndex + 1} value`}
                                value={condition.value || "true"}
                                onChange={(event) =>
                                  updateCondition(index, conditionIndex, {
                                    value: event.target.value,
                                  })
                                }
                              >
                                <option value="true">Present</option>
                                <option value="false">Missing</option>
                              </select>
                            ) : (
                              <input
                                aria-label={`Condition ${conditionIndex + 1} value`}
                                inputMode={
                                  condition.operator === "gte" ||
                                  condition.operator === "lte"
                                    ? "decimal"
                                    : "text"
                                }
                                placeholder={
                                  condition.operator === "in"
                                    ? "SMB, Mid-market, Enterprise"
                                    : "Value"
                                }
                                value={condition.value}
                                onChange={(event) =>
                                  updateCondition(index, conditionIndex, {
                                    value: event.target.value,
                                  })
                                }
                              />
                            )}
                          </label>
                          <button
                            type="button"
                            className="condition-remove"
                            aria-label={`Remove condition ${conditionIndex + 1}`}
                            disabled={rule.conditions.length === 1}
                            onClick={() =>
                              removeCondition(index, conditionIndex)
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="condition-add"
                      onClick={() => addCondition(index)}
                    >
                      + Add condition
                    </button>
                  </fieldset>
                )}
                <div className="studio-editor-actions">
                  <button
                    type="button"
                    className="studio-save"
                    disabled={savingRule === rule.clientKey}
                    onClick={() => void saveRule(index)}
                  >
                    {savingRule === rule.clientKey ? "Saving…" : "Save rule"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="studio-section preview-section" id="test-route">
        <div className="card-heading">
          <div>
            <span className="section-number">06</span>
            <div>
              <h2>Test a route</h2>
              <p>
                Preview the winner and every decision without changing data.
              </p>
            </div>
          </div>
          <span className="preview-safe-badge">ZERO SIDE EFFECTS</span>
        </div>
        <div className="preview-safety-note">
          <span aria-hidden="true">✓</span>
          <p>
            <b>Safe simulation.</b> This does not save a decision, advance round
            robin counters, queue a job, write to CRM, or touch a calendar. It
            uses saved working hours and does not contact live calendar
            providers.
          </p>
        </div>
        <div className="preview-workspace">
          <form
            className="preview-form"
            onSubmit={(event) => void runPreview(event)}
          >
            <div className="preview-form-heading">
              <span>TEST LEAD</span>
              <small>Fields follow the saved active rules.</small>
            </div>
            <div className="preview-field-grid">
              <label>
                <span>
                  Preview at
                  <code>evaluatedAt</code>
                </span>
                <input
                  type="datetime-local"
                  required
                  value={previewAt}
                  onChange={(event) => setPreviewAt(event.target.value)}
                />
              </label>
              {previewFields.map((field) => {
                const kind = fieldInputKind(field);
                const isEmail =
                  field === "email" || field === "current_owner_email";
                return (
                  <label key={field}>
                    <span>
                      {fieldLabel(field)}
                      <code>{field}</code>
                    </span>
                    {kind === "boolean" ? (
                      <select
                        value={previewValues[field] ?? ""}
                        onChange={(event) =>
                          setPreviewValues((current) => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Not provided</option>
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    ) : (
                      <input
                        type={isEmail ? "email" : kind}
                        required={field === "email"}
                        placeholder={previewPlaceholder(field)}
                        value={previewValues[field] ?? ""}
                        onChange={(event) =>
                          setPreviewValues((current) => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                );
              })}
            </div>
            <button
              className="preview-submit"
              type="submit"
              disabled={previewing}
            >
              {previewing ? "Evaluating route…" : "Run safe preview"}
              <span aria-hidden="true">↗</span>
            </button>
          </form>

          <div className="preview-results" aria-live="polite">
            <InlineNotice notice={previewNotice} />
            {!preview && !previewing && (
              <div className="preview-empty">
                <span aria-hidden="true">⌘</span>
                <h3>Ready to explain the route.</h3>
                <p>
                  Submit a test lead to see the selected rule, eligible pool,
                  expected representative, and every exclusion.
                </p>
              </div>
            )}
            {previewing && (
              <div className="preview-empty">
                <span className="preview-spinner" aria-hidden="true" />
                <h3>Evaluating the current rules…</h3>
              </div>
            )}
            {preview && (
              <div className="preview-trace">
                <div className="preview-outcome">
                  <div>
                    <span
                      className={`outcome-badge ${preview.outcome.replaceAll("_", "-")}`}
                    >
                      {preview.outcome.replaceAll("_", " ")}
                    </span>
                    <small>{formatEvaluatedAt(preview.evaluatedAt)}</small>
                  </div>
                  {preview.selectedRep ? (
                    <div className="preview-winner">
                      <span>EXPECTED OWNER</span>
                      <h3>{preview.selectedRep.name}</h3>
                      <p>{preview.selectedRep.email}</p>
                      <small>
                        {preview.reason === "owner_preserved"
                          ? "Existing owner preserved"
                          : "Weighted round robin"}
                      </small>
                    </div>
                  ) : (
                    <div className="preview-winner no-winner">
                      <span>EXPECTED OWNER</span>
                      <h3>No representative selected</h3>
                    </div>
                  )}
                  <dl>
                    <div>
                      <dt>Rule</dt>
                      <dd>
                        {preview.selectedRule?.name ?? "No matching rule"}
                      </dd>
                    </div>
                    <div>
                      <dt>Pool</dt>
                      <dd>
                        {poolDrafts.find(
                          (pool) => pool.id === preview.selectedRule?.poolId,
                        )?.name ?? "—"}
                      </dd>
                    </div>
                  </dl>
                </div>

                <section
                  className="trace-group"
                  aria-labelledby="rule-trace-heading"
                >
                  <div className="trace-heading">
                    <div>
                      <span>01</span>
                      <h3 id="rule-trace-heading">Rule evaluation</h3>
                    </div>
                    <small>{preview.rules.length} checked</small>
                  </div>
                  <ol className="trace-rule-list">
                    {preview.rules.map((rule) => (
                      <li
                        className={rule.matched ? "matched" : "not-matched"}
                        key={rule.id}
                      >
                        <div>
                          <span>
                            {rule.conditions.length === 0
                              ? "LAST"
                              : `P${rule.priority}`}
                          </span>
                          <b>{rule.name}</b>
                          <em>
                            {rule.conditions.length === 0
                              ? preview.selectedRule?.id === rule.id
                                ? "SELECTED"
                                : "FALLBACK"
                              : rule.matched
                                ? "MATCHED"
                                : "NO MATCH"}
                          </em>
                        </div>
                        <ul>
                          {rule.conditions.length === 0 && (
                            <li className="trace-catch-all">
                              <span aria-hidden="true">↳</span>
                              <p>
                                <b>Catch-all</b>
                                <small>
                                  Evaluated after every conditional rule
                                </small>
                              </p>
                            </li>
                          )}
                          {rule.conditions.map((condition, index) => (
                            <li key={`${rule.id}-${condition.field}-${index}`}>
                              <span aria-hidden="true">
                                {condition.matched ? "✓" : "×"}
                              </span>
                              <p>
                                <b>{condition.field}</b>
                                <small>
                                  {operators.find(
                                    (operator) =>
                                      operator.value === condition.operator,
                                  )?.label ?? condition.operator}{" "}
                                  <code>
                                    {formatTraceValue(condition.expected)}
                                  </code>
                                </small>
                              </p>
                              <p>
                                <small>Received</small>
                                <code>
                                  {formatTraceValue(condition.actual)}
                                </code>
                              </p>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                </section>

                <section
                  className="trace-group"
                  aria-labelledby="rep-trace-heading"
                >
                  <div className="trace-heading">
                    <div>
                      <span>02</span>
                      <h3 id="rep-trace-heading">Representative eligibility</h3>
                    </div>
                    <small>{preview.reps.length} checked</small>
                  </div>
                  <div className="trace-rep-list">
                    {preview.reps.map((rep) => (
                      <article
                        className={`${rep.eligible ? "eligible" : "excluded"} ${rep.selected ? "selected" : ""}`}
                        key={rep.id}
                      >
                        <div>
                          <span className="rep-avatar">
                            {rep.name
                              .split(" ")
                              .map((part) => part[0])
                              .join("")
                              .slice(0, 2)}
                          </span>
                          <p>
                            <b>{rep.name}</b>
                            <small>{rep.email}</small>
                          </p>
                          <em>
                            {rep.selected
                              ? "SELECTED"
                              : rep.eligible
                                ? "ELIGIBLE"
                                : "EXCLUDED"}
                          </em>
                        </div>
                        <dl>
                          <div>
                            <dt>Assignments</dt>
                            <dd>{rep.assignments}</dd>
                          </div>
                          <div>
                            <dt>Weight</dt>
                            <dd>{rep.weight}×</dd>
                          </div>
                          <div>
                            <dt>Schedule</dt>
                            <dd>{rep.scheduled ? "Open" : "Closed"}</dd>
                          </div>
                          <div>
                            <dt>Availability</dt>
                            <dd>{rep.unavailable ? "Busy" : "Available"}</dd>
                          </div>
                        </dl>
                        {rep.exclusionReason && (
                          <p className="exclusion-reason">
                            {rep.exclusionReason.replaceAll("_", " ")}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
