import type {
  Dashboard,
  DashboardCalendarConnection,
  DashboardRep,
  RouterLink,
} from "@hot-potato/db";

export type CalendarProvider = "google" | "microsoft";

export type WorkspaceConnection = {
  provider: "hubspot" | CalendarProvider;
  configured: boolean;
  connected: boolean;
  scopes: string[];
};

const hubSpotContactReadScope = "crm.objects.contacts.read";
const hubSpotOwnerReadScope = "crm.objects.owners.read";

export function hubSpotConnectionNeedsReconnect(
  connection: WorkspaceConnection | undefined,
): boolean {
  return Boolean(
    connection?.provider === "hubspot" &&
      connection.connected &&
      (!connection.configured ||
        !connection.scopes.includes(hubSpotContactReadScope) ||
        !connection.scopes.includes(hubSpotOwnerReadScope)),
  );
}

export type RouterLinkReadinessDraft = Omit<
  RouterLink,
  "id" | "destinations"
> & {
  id?: string;
  destinations: Array<{ poolId: string; meetingTypeId: string }>;
};

export type WorkspaceStageId = "team" | "calendars" | "route" | "publish";
export type WorkspaceStageStatus = "complete" | "current" | "blocked";

export type WorkspaceStage = {
  id: WorkspaceStageId;
  title: string;
  description: string;
  status: WorkspaceStageStatus;
};

export type WorkspaceAction = {
  href: string;
  label: string;
};

export type WorkspaceReadiness = {
  complete: boolean;
  completedStages: number;
  stages: WorkspaceStage[];
  primaryAction: WorkspaceAction | null;
  publishedLink: RouterLink | null;
};

export type RouterRuleFieldEvidence = {
  values: unknown[];
  hasChoiceOperator: boolean;
  hasNumberOperator: boolean;
  hasBooleanValue: boolean;
  hasNonExistsPredicate: boolean;
  hasExistsFalse: boolean;
  hasExistsTrue: boolean;
  ruleIds: Set<string>;
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const accentPattern = /^#[0-9a-fA-F]{6}$/;
const publicFieldPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const fixedIdentityFields = new Set(["email", "name"]);
const unsupportedPublicFields = new Set([
  "attendee_name",
  "current_owner_email",
]);

function validSuccessRedirect(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return (
      value.length <= 2_048 &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && loopback))
    );
  } catch {
    return false;
  }
}

export function activeRules(dashboard: Dashboard) {
  return [...dashboard.rules]
    .filter((rule) => rule.active)
    .sort((left, right) => left.priority - right.priority);
}

export function ruleFieldEvidence(
  dashboard: Dashboard,
): Map<string, RouterRuleFieldEvidence> {
  const fields = new Map<string, RouterRuleFieldEvidence>();
  for (const rule of activeRules(dashboard)) {
    for (const [field, rawPredicate] of Object.entries(rule.conditions)) {
      if (
        fixedIdentityFields.has(field) ||
        unsupportedPublicFields.has(field)
      ) {
        continue;
      }
      const evidence = fields.get(field) ?? {
        values: [],
        hasChoiceOperator: false,
        hasNumberOperator: false,
        hasBooleanValue: false,
        hasNonExistsPredicate: false,
        hasExistsFalse: false,
        hasExistsTrue: false,
        ruleIds: new Set<string>(),
      };
      const predicate = rawPredicate as Record<string, unknown>;
      evidence.ruleIds.add(rule.id);
      if (Array.isArray(predicate.in)) {
        evidence.hasChoiceOperator = true;
        evidence.hasNonExistsPredicate = true;
        evidence.values.push(...predicate.in);
      }
      if ("gte" in predicate || "lte" in predicate) {
        evidence.hasNumberOperator = true;
        evidence.hasNonExistsPredicate = true;
      }
      if ("eq" in predicate) {
        evidence.hasNonExistsPredicate = true;
        evidence.values.push(predicate.eq);
        if (typeof predicate.eq === "number") {
          evidence.hasNumberOperator = true;
        }
        if (typeof predicate.eq === "boolean") {
          evidence.hasBooleanValue = true;
        }
      }
      if ("contains" in predicate) evidence.hasNonExistsPredicate = true;
      if (predicate.exists === false) evidence.hasExistsFalse = true;
      if (predicate.exists === true) evidence.hasExistsTrue = true;
      fields.set(field, evidence);
    }
  }
  for (const [field, evidence] of fields) {
    if (
      evidence.hasExistsFalse &&
      !evidence.hasExistsTrue &&
      !evidence.hasNonExistsPredicate
    ) {
      fields.delete(field);
    }
  }
  return fields;
}

export function reachablePools(dashboard: Dashboard) {
  const poolIds = new Set(activeRules(dashboard).map((rule) => rule.poolId));
  return dashboard.pools.filter((pool) => poolIds.has(pool.id));
}

export function compatibleMeetingTypes(dashboard: Dashboard, poolId: string) {
  return dashboard.meetingTypes.filter(
    (meetingType) =>
      meetingType.active &&
      meetingType.targetType === "pool" &&
      meetingType.targetId === poolId,
  );
}

export function meetingTypeHasReadyHost(
  dashboard: Dashboard,
  poolId: string,
  meetingTypeId: string,
): boolean {
  const pool = dashboard.pools.find((candidate) => candidate.id === poolId);
  const meetingType = dashboard.meetingTypes.find(
    (candidate) => candidate.id === meetingTypeId,
  );
  if (!pool || !meetingType) return false;
  return pool.members.some((rep) => {
    if (!rep.active || !rep.activeCalendarProvider) return false;
    const calendar =
      rep.activeCalendarProvider === "google"
        ? rep.googleCalendar
        : rep.microsoftCalendar;
    if (!calendarConnectionIsReady(calendar)) return false;
    if (meetingType.conferenceProvider === "google_meet") {
      return rep.activeCalendarProvider === "google";
    }
    if (meetingType.conferenceProvider === "microsoft_teams") {
      return rep.activeCalendarProvider === "microsoft";
    }
    return true;
  });
}

export function readinessErrors(
  draft: RouterLinkReadinessDraft,
  dashboard: Dashboard,
): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length < 2) errors.push("Add an internal link name.");
  if (!slugPattern.test(draft.slug)) errors.push("Choose a valid public slug.");
  if (draft.title.trim().length < 2) errors.push("Add a public page title.");
  if (draft.buttonLabel.trim().length < 2) {
    errors.push("Add button copy for the qualification form.");
  }
  if (draft.noMatchMessage.trim().length < 2) {
    errors.push("Add a safe no-match message.");
  }
  if (!accentPattern.test(draft.accentColor)) {
    errors.push("Use a six-digit hex accent color.");
  }
  if (
    draft.successRedirectUrl &&
    !validSuccessRedirect(draft.successRedirectUrl.trim())
  ) {
    errors.push("Use a safe HTTPS post-booking redirect URL.");
  }
  if (
    !Number.isInteger(draft.successRedirectDelaySeconds) ||
    draft.successRedirectDelaySeconds < 1 ||
    draft.successRedirectDelaySeconds > 30
  ) {
    errors.push("Keep the post-booking confirmation visible for 1–30 seconds.");
  }

  const rules = activeRules(dashboard);
  if (rules.length === 0) {
    errors.push("Activate at least one routing rule.");
  }
  const unsupportedField = rules
    .flatMap((rule) => Object.keys(rule.conditions))
    .find((field) => unsupportedPublicFields.has(field));
  if (unsupportedField) {
    errors.push(
      `${unsupportedField} cannot be collected by a public Smart Link. Update the active rules first.`,
    );
  }
  const missingIdentityRule = rules.find((rule) =>
    Object.entries(rule.conditions).some(
      ([field, predicate]) =>
        fixedIdentityFields.has(field) &&
        (predicate as Record<string, unknown>).exists === false,
    ),
  );
  if (missingIdentityRule) {
    errors.push(
      `${missingIdentityRule.name} requires a missing name or email, but the public form always collects both.`,
    );
  }

  const expectedFields = [...ruleFieldEvidence(dashboard).keys()];
  const questionFields = draft.questions.map((question) => question.field);
  if (draft.questions.length > 20) {
    errors.push("Use no more than 20 public questions.");
  }
  if (new Set(questionFields).size !== questionFields.length) {
    errors.push("Each routing field can appear only once.");
  }
  if (
    questionFields.some((field) =>
      questionFields.some(
        (candidate) =>
          candidate !== field &&
          (candidate.startsWith(`${field}.`) ||
            field.startsWith(`${candidate}.`)),
      ),
    )
  ) {
    errors.push("Routing question fields cannot contain one another.");
  }
  for (const field of expectedFields) {
    if (field.length > 120 || !publicFieldPattern.test(field)) {
      errors.push(`${field} is not a safe public routing field path.`);
      continue;
    }
    const question = draft.questions.find(
      (candidate) => candidate.field === field,
    );
    if (!question) {
      errors.push(`Add a public question for ${field}.`);
      continue;
    }
    if (!question.label.trim()) {
      errors.push(`Add a label for ${field}.`);
    }
    if (question.type === "select" && question.options.length === 0) {
      errors.push(`Add at least one option for ${question.label || field}.`);
    }
    if (
      question.options.length > 50 ||
      question.options.some(
        (option) => option.length < 1 || option.length > 100,
      )
    ) {
      errors.push(`Keep ${question.label || field} to 50 concise options.`);
    }
    if (
      new Set(question.options.map((option) => option.trim().toLowerCase()))
        .size !== question.options.length
    ) {
      errors.push(`Use each ${question.label || field} option only once.`);
    }
  }

  const destinations = new Map(
    draft.destinations.map((destination) => [destination.poolId, destination]),
  );
  for (const pool of reachablePools(dashboard)) {
    const destination = destinations.get(pool.id);
    if (!destination?.meetingTypeId) {
      errors.push(`Choose a meeting type for ${pool.name}.`);
      continue;
    }
    const compatible = compatibleMeetingTypes(dashboard, pool.id).some(
      (meetingType) => meetingType.id === destination.meetingTypeId,
    );
    if (!compatible) {
      errors.push(`Choose an active pool meeting type for ${pool.name}.`);
      continue;
    }
    if (
      !meetingTypeHasReadyHost(dashboard, pool.id, destination.meetingTypeId)
    ) {
      errors.push(
        `${pool.name} needs an active representative with a compatible connected calendar.`,
      );
    }
  }
  return errors;
}

function calendarConnectionIsReady(
  connection: DashboardCalendarConnection,
): boolean {
  const selectedCalendars = connection.calendars.filter(
    (calendar) => calendar.selected,
  );
  return (
    connection.connected &&
    connection.checkConflicts &&
    selectedCalendars.length > 0 &&
    selectedCalendars.every((calendar) => calendar.available)
  );
}

function repHasConfiguredBookingCalendar(
  rep: DashboardRep,
  configuredProviders: ReadonlySet<CalendarProvider>,
): boolean {
  if (!rep.active || !rep.activeCalendarProvider) return false;
  if (!configuredProviders.has(rep.activeCalendarProvider)) return false;
  const calendar =
    rep.activeCalendarProvider === "google"
      ? rep.googleCalendar
      : rep.microsoftCalendar;
  return calendarConnectionIsReady(calendar);
}

function meetingTypeHasConfiguredReadyHost(
  dashboard: Dashboard,
  poolId: string,
  meetingTypeId: string,
  configuredProviders: ReadonlySet<CalendarProvider>,
): boolean {
  const pool = dashboard.pools.find((candidate) => candidate.id === poolId);
  const meetingType = dashboard.meetingTypes.find(
    (candidate) => candidate.id === meetingTypeId,
  );
  if (!pool || !meetingType) return false;
  return pool.members.some((rep) => {
    if (!repHasConfiguredBookingCalendar(rep, configuredProviders)) {
      return false;
    }
    if (meetingType.conferenceProvider === "google_meet") {
      return rep.activeCalendarProvider === "google";
    }
    if (meetingType.conferenceProvider === "microsoft_teams") {
      return rep.activeCalendarProvider === "microsoft";
    }
    return true;
  });
}

function publishedReadyLink(dashboard: Dashboard): RouterLink | null {
  return (
    dashboard.routerLinks.find(
      (link) => link.active && readinessErrors(link, dashboard).length === 0,
    ) ?? null
  );
}

export function deriveWorkspaceReadiness(
  dashboard: Dashboard,
  connections: WorkspaceConnection[],
): WorkspaceReadiness {
  const activeReps = dashboard.reps.filter((rep) => rep.active);
  const teamPool = dashboard.pools.find((pool) =>
    pool.members.some((rep) => rep.active),
  );
  const teamComplete = Boolean(teamPool);

  const configuredProviders = new Set<CalendarProvider>(
    connections
      .filter(
        (
          connection,
        ): connection is WorkspaceConnection & {
          provider: CalendarProvider;
        } =>
          connection.configured &&
          (connection.provider === "google" ||
            connection.provider === "microsoft"),
      )
      .map((connection) => connection.provider),
  );
  const calendarPool = dashboard.pools.find((pool) =>
    pool.members.some((rep) =>
      repHasConfiguredBookingCalendar(rep, configuredProviders),
    ),
  );
  const calendarRep = calendarPool?.members.find((rep) =>
    repHasConfiguredBookingCalendar(rep, configuredProviders),
  );
  const calendarsComplete = Boolean(calendarPool && calendarRep);

  const hubSpotNeedsReconnect = hubSpotConnectionNeedsReconnect(
    connections.find((connection) => connection.provider === "hubspot"),
  );
  const rules = activeRules(dashboard);
  const routeDetails = rules.map((rule) => {
    const pool = dashboard.pools.find(
      (candidate) => candidate.id === rule.poolId,
    );
    const calendarReady = Boolean(
      pool?.members.some((rep) =>
        repHasConfiguredBookingCalendar(rep, configuredProviders),
      ),
    );
    const meetingType = pool
      ? compatibleMeetingTypes(dashboard, pool.id).find((candidate) =>
          meetingTypeHasConfiguredReadyHost(
            dashboard,
            pool.id,
            candidate.id,
            configuredProviders,
          ),
        )
      : undefined;
    return { rule, pool, calendarReady, meetingType };
  });
  const routeSummary = routeDetails.find((detail) => detail.meetingType);
  const routeMissingCalendar = routeDetails.find(
    (detail) => !detail.pool || !detail.calendarReady,
  );
  const routeMissingMeetingType = routeDetails.find(
    (detail) => detail.calendarReady && !detail.meetingType,
  );
  const routeComplete =
    !hubSpotNeedsReconnect &&
    routeDetails.length > 0 &&
    routeDetails.every(
      (detail) => detail.pool && detail.calendarReady && detail.meetingType,
    );

  const readyLink = publishedReadyLink(dashboard);
  const publishComplete = routeComplete && Boolean(readyLink);
  const completion = [
    teamComplete,
    calendarsComplete,
    routeComplete,
    publishComplete,
  ];
  const firstIncomplete = completion.findIndex((complete) => !complete);
  const stageStatus = (index: number): WorkspaceStageStatus => {
    if (completion[index]) return "complete";
    return index === firstIncomplete ? "current" : "blocked";
  };

  const calendarName =
    calendarRep?.activeCalendarProvider === "google"
      ? "Google Calendar"
      : calendarRep?.activeCalendarProvider === "microsoft"
        ? "Outlook"
        : null;
  const stages: WorkspaceStage[] = [
    {
      id: "team",
      title: "Build the team",
      description: teamPool
        ? `${teamPool.name} has an active representative ready for routing.`
        : activeReps.length > 0
          ? "Put an active representative into a routing pool."
          : "Add the first person who can own and book a meeting.",
      status: stageStatus(0),
    },
    {
      id: "calendars",
      title: "Connect calendars",
      description:
        calendarPool && calendarRep && calendarName
          ? `${calendarRep.name} can receive bookings through ${calendarName}.`
          : configuredProviders.size === 0
            ? "Configure Google or Microsoft OAuth before connecting a rep."
            : "Connect a pooled rep's Google or Outlook booking calendar.",
      status: stageStatus(1),
    },
    {
      id: "route",
      title: "Define the route",
      description: hubSpotNeedsReconnect
        ? "Reconnect HubSpot so routing can verify CRM ownership with the required read access."
        : routeComplete && routeSummary?.meetingType
          ? `${routeSummary.rule.name} leads to ${routeSummary.meetingType.title}.`
          : rules.length === 0
            ? "Add an active rule that sends buyers to a calendar-ready pool."
            : routeMissingCalendar
              ? "Connect a booking calendar for every pool reached by an active rule."
              : "Add an active pool meeting type compatible with each host calendar.",
      status: stageStatus(2),
    },
    {
      id: "publish",
      title: "Publish the experience",
      description:
        publishComplete && readyLink
          ? `${readyLink.name} is live and ready to share.`
          : readyLink
            ? `${readyLink.name} exists, but launch dependencies still need repair.`
            : "Publish one Smart Link only after every route has a bookable destination.",
      status: stageStatus(3),
    },
  ];

  let primaryAction: WorkspaceAction | null = null;
  if (!teamComplete) {
    primaryAction =
      activeReps.length === 0
        ? { href: "#reps", label: "Add a representative" }
        : { href: "#pools", label: "Build a routing pool" };
  } else if (!calendarsComplete) {
    primaryAction =
      configuredProviders.size === 0
        ? { href: "#connections", label: "Configure Google or Outlook" }
        : { href: "#calendar-readiness", label: "Connect a rep calendar" };
  } else if (!routeComplete) {
    primaryAction = hubSpotNeedsReconnect
      ? { href: "#connection-hubspot", label: "Reconnect HubSpot" }
      : rules.length === 0
        ? { href: "#rules", label: "Create a routing rule" }
        : routeMissingCalendar
          ? {
              href: "#calendar-readiness",
              label: "Connect a routed rep calendar",
            }
          : routeMissingMeetingType
            ? { href: "#meeting-types", label: "Add a pool meeting type" }
            : { href: "#rules", label: "Review routing rules" };
  } else if (!publishComplete) {
    primaryAction = { href: "#smart-links", label: "Publish a Smart Link" };
  }

  return {
    complete: publishComplete,
    completedStages: completion.filter(Boolean).length,
    stages,
    primaryAction,
    publishedLink: publishComplete ? readyLink : null,
  };
}
