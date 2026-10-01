import type {
  Dashboard,
  DashboardCalendarConnection,
  DashboardRep,
  MeetingType,
} from "@hot-potato/db";
import {
  HUBSPOT_CONTACT_READ_SCOPE,
  HUBSPOT_OWNER_READ_SCOPE,
} from "@hot-potato/integrations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceLaunchpad } from "../components/workspace-launchpad";
import {
  deriveWorkspaceReadiness,
  readinessErrors,
  type CalendarProvider,
  type WorkspaceConnection,
} from "../components/workspace-readiness";

const noCalendar: DashboardCalendarConnection = {
  connected: false,
  accountName: null,
  checkConflicts: false,
  canSyncCalendars: false,
  calendarCatalogSyncedAt: null,
  calendarCatalogError: null,
  calendars: [],
};

function connectedCalendar(name: string): DashboardCalendarConnection {
  return {
    ...noCalendar,
    connected: true,
    accountName: name,
    checkConflicts: true,
    canSyncCalendars: true,
    calendars: [
      {
        calendarId: "provider-default",
        name: "Default calendar",
        isDefault: true,
        selected: true,
        available: true,
        lastSeenAt: "2026-08-31T12:00:00.000Z",
        missingSince: null,
      },
    ],
  };
}

function rep(provider: CalendarProvider | null): DashboardRep {
  return {
    id: "rep-1",
    name: "Alex Rivera",
    email: "alex@example.com",
    weight: 1,
    active: true,
    timezone: "America/New_York",
    availability: {
      monday: [{ start: "09:00", end: "17:00" }],
    },
    availabilityOverrides: {},
    availabilityScheduleId: null,
    availabilityScheduleName: null,
    dailyMeetingLimit: null,
    weeklyMeetingLimit: null,
    assignments: 0,
    schedulingSlug: "alex-rivera",
    meetingDurationMinutes: 30,
    activeCalendarProvider: provider,
    googleCalendar:
      provider === "google"
        ? connectedCalendar("alex@example.com")
        : noCalendar,
    microsoftCalendar:
      provider === "microsoft" ? connectedCalendar("Alex Rivera") : noCalendar,
  };
}

function emptyDashboard(): Dashboard {
  return {
    organization: { name: "Test workspace", slug: "test" },
    stats: {
      routesToday: 0,
      activeReps: 0,
      activeRules: 0,
      pendingJobs: 0,
    },
    reps: [],
    availabilitySchedules: [],
    pools: [],
    rules: [],
    meetingTypes: [],
    routerLinks: [],
    routerFormBridges: [],
    decisions: [],
  };
}

function providerConnections(
  ...configured: CalendarProvider[]
): WorkspaceConnection[] {
  return [
    {
      provider: "hubspot",
      configured: false,
      connected: false,
      scopes: [],
    },
    {
      provider: "google",
      configured: configured.includes("google"),
      connected: false,
      scopes: [],
    },
    {
      provider: "microsoft",
      configured: configured.includes("microsoft"),
      connected: false,
      scopes: [],
    },
  ];
}

function routedDashboard(
  provider: CalendarProvider,
  conferenceProvider: MeetingType["conferenceProvider"] = provider === "google"
    ? "google_meet"
    : "microsoft_teams",
): Dashboard {
  const host = rep(provider);
  const dashboard = emptyDashboard();
  dashboard.reps = [host];
  dashboard.pools = [
    {
      id: "pool-1",
      name: "Enterprise",
      slug: "enterprise",
      strategy: "weighted_round_robin",
      members: [host],
    },
  ];
  dashboard.rules = [
    {
      id: "rule-1",
      name: "Enterprise buyers",
      priority: 1,
      conditions: { "company.employee_count": { gte: 100 } },
      poolId: "pool-1",
      poolName: "Enterprise",
      active: true,
    },
  ];
  dashboard.meetingTypes = [
    {
      id: "meeting-1",
      slug: "enterprise-intro",
      title: "Enterprise introduction",
      description: "Pick a time that works.",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 60,
      bookingWindowDays: 14,
      inviteeLimitScope: "none",
      inviteeLimitCount: null,
      rescheduleCutoffMinutes: 0,
      cancelCutoffMinutes: 0,
      conferenceProvider,
      zoomJoinUrl: null,
      reminderMinutes: 1440,
      active: true,
      targetType: "pool",
      targetId: "pool-1",
      targetName: "Enterprise",
      cohosts: [],
      cohostGroups: [],
    },
  ];
  dashboard.routerLinks = [
    {
      id: "link-1",
      name: "Enterprise router",
      slug: "enterprise-router",
      title: "Find the right time",
      description: "Tell us about your team.",
      buttonLabel: "Find my time",
      noMatchMessage: "Our team will follow up.",
      successRedirectUrl: null,
      successRedirectDelaySeconds: 5,
      accentColor: "#ff5d2e",
      active: true,
      questions: [
        {
          field: "company.employee_count",
          label: "Company size",
          type: "number",
          required: true,
          placeholder: "Enter a number",
          helpText: "",
          options: [],
        },
      ],
      destinations: [
        {
          poolId: "pool-1",
          poolName: "Enterprise",
          meetingTypeId: "meeting-1",
          meetingTypeTitle: "Enterprise introduction",
          meetingTypeSlug: "enterprise-intro",
        },
      ],
    },
  ];
  return dashboard;
}

function currentStages(readiness: ReturnType<typeof deriveWorkspaceReadiness>) {
  return readiness.stages.filter((stage) => stage.status === "current");
}

describe("workspace launch readiness", () => {
  it("starts an empty bootstrap with exactly one representative action", () => {
    const readiness = deriveWorkspaceReadiness(
      emptyDashboard(),
      providerConnections(),
    );

    expect(readiness.complete).toBe(false);
    expect(readiness.completedStages).toBe(0);
    expect(readiness.primaryAction).toEqual({
      href: "#reps",
      label: "Add a representative",
    });
    expect(currentStages(readiness).map((stage) => stage.id)).toEqual(["team"]);
  });

  it("moves a saved but unpooled representative to the pool action", () => {
    const dashboard = emptyDashboard();
    dashboard.reps = [rep(null)];

    const readiness = deriveWorkspaceReadiness(
      dashboard,
      providerConnections("google"),
    );

    expect(readiness.primaryAction).toEqual({
      href: "#pools",
      label: "Build a routing pool",
    });
  });

  it("does not call a connected rep ready when provider configuration is absent", () => {
    const dashboard = routedDashboard("google");
    dashboard.rules = [];
    dashboard.meetingTypes = [];
    dashboard.routerLinks = [];

    const readiness = deriveWorkspaceReadiness(
      dashboard,
      providerConnections(),
    );

    expect(readiness.completedStages).toBe(1);
    expect(readiness.primaryAction).toEqual({
      href: "#connections",
      label: "Configure Google or Outlook",
    });
    expect(currentStages(readiness).map((stage) => stage.id)).toEqual([
      "calendars",
    ]);
  });

  it("advances either configured calendar provider to the same routing step", () => {
    for (const provider of ["google", "microsoft"] as const) {
      const dashboard = routedDashboard(provider);
      dashboard.rules = [];
      dashboard.meetingTypes = [];
      dashboard.routerLinks = [];

      const readiness = deriveWorkspaceReadiness(
        dashboard,
        providerConnections(provider),
      );

      expect(readiness.completedStages).toBe(2);
      expect(readiness.primaryAction).toEqual({
        href: "#rules",
        label: "Create a routing rule",
      });
      expect(currentStages(readiness).map((stage) => stage.id)).toEqual([
        "route",
      ]);
    }
  });

  it("does not publish a route with no selected calendar or a stale selected calendar", () => {
    for (const brokenCalendar of [
      { calendars: [], checkConflicts: false },
      {
        calendars: [
          {
            calendarId: "provider-default",
            name: "Missing default",
            isDefault: true,
            selected: true,
            available: false,
            lastSeenAt: "2026-08-30T12:00:00.000Z",
            missingSince: "2026-08-31T12:00:00.000Z",
          },
        ],
        checkConflicts: true,
      },
    ]) {
      const dashboard = routedDashboard("google");
      Object.assign(dashboard.reps[0]!.googleCalendar, brokenCalendar);

      const readiness = deriveWorkspaceReadiness(
        dashboard,
        providerConnections("google"),
      );

      expect(readiness.complete).toBe(false);
      expect(readiness.completedStages).toBe(1);
      expect(readiness.publishedLink).toBeNull();
      expect(readiness.primaryAction).toEqual({
        href: "#calendar-readiness",
        label: "Connect a rep calendar",
      });
      expect(readinessErrors(dashboard.routerLinks[0]!, dashboard)).toContain(
        "Enterprise needs an active representative with a compatible connected calendar.",
      );
    }
  });

  it("blocks a meeting-provider mismatch for both Google and Outlook", () => {
    const cases = [
      ["google", "microsoft_teams"],
      ["microsoft", "google_meet"],
    ] as const;

    for (const [provider, conference] of cases) {
      const dashboard = routedDashboard(provider, conference);
      const readiness = deriveWorkspaceReadiness(
        dashboard,
        providerConnections(provider),
      );

      expect(readiness.complete).toBe(false);
      expect(readiness.completedStages).toBe(2);
      expect(readiness.primaryAction).toEqual({
        href: "#meeting-types",
        label: "Add a pool meeting type",
      });
      expect(readinessErrors(dashboard.routerLinks[0]!, dashboard)).toContain(
        "Enterprise needs an active representative with a compatible connected calendar.",
      );
    }
  });

  it("keeps HubSpot optional unless an active connection needs ownership access", () => {
    const dashboard = routedDashboard("google");
    const optional = providerConnections("google");
    optional[0] = {
      provider: "hubspot",
      configured: false,
      connected: false,
      scopes: [],
    };
    const disconnectedConfigured = structuredClone(optional);
    disconnectedConfigured[0]!.configured = true;
    const storedWithoutRuntimeConfig = structuredClone(optional);
    storedWithoutRuntimeConfig[0]!.connected = true;
    const stale = structuredClone(optional);
    stale[0] = {
      provider: "hubspot",
      configured: true,
      connected: true,
      scopes: ["oauth", "crm.objects.contacts.write"],
    };
    const contactOnly = structuredClone(stale);
    contactOnly[0]!.scopes.push(HUBSPOT_CONTACT_READ_SCOPE);
    const refreshed = structuredClone(contactOnly);
    refreshed[0]!.scopes.push(HUBSPOT_OWNER_READ_SCOPE);

    expect(deriveWorkspaceReadiness(dashboard, optional).complete).toBe(true);
    expect(
      deriveWorkspaceReadiness(dashboard, disconnectedConfigured).complete,
    ).toBe(true);

    const unconfiguredBlocked = deriveWorkspaceReadiness(
      dashboard,
      storedWithoutRuntimeConfig,
    );
    expect(unconfiguredBlocked.primaryAction).toEqual({
      href: "#connection-hubspot",
      label: "Reconnect HubSpot",
    });

    const blocked = deriveWorkspaceReadiness(dashboard, stale);
    expect(blocked.complete).toBe(false);
    expect(blocked.completedStages).toBe(2);
    expect(blocked.primaryAction).toEqual({
      href: "#connection-hubspot",
      label: "Reconnect HubSpot",
    });
    expect(blocked.stages[2]?.description).toContain("Reconnect HubSpot");
    expect(blocked.stages[3]?.description).toContain(
      "launch dependencies still need repair",
    );

    expect(deriveWorkspaceReadiness(dashboard, contactOnly).complete).toBe(
      false,
    );

    expect(deriveWorkspaceReadiness(dashboard, refreshed).complete).toBe(true);
  });

  it("requires every actively routed pool to have a configured booking path", () => {
    const dashboard = routedDashboard("google");
    const outlookHost = rep("microsoft");
    outlookHost.id = "rep-2";
    outlookHost.email = "jamie@example.com";
    dashboard.reps.push(outlookHost);
    dashboard.pools.push({
      id: "pool-2",
      name: "Commercial",
      slug: "commercial",
      strategy: "weighted_round_robin",
      members: [outlookHost],
    });
    dashboard.rules.push({
      id: "rule-2",
      name: "Commercial buyers",
      priority: 2,
      conditions: { "company.employee_count": { lte: 99 } },
      poolId: "pool-2",
      poolName: "Commercial",
      active: true,
    });

    const readiness = deriveWorkspaceReadiness(
      dashboard,
      providerConnections("google"),
    );

    expect(readiness.complete).toBe(false);
    expect(readiness.completedStages).toBe(2);
    expect(readiness.primaryAction).toEqual({
      href: "#calendar-readiness",
      label: "Connect a routed rep calendar",
    });
  });

  it("reaches the identical complete state through Google or Outlook", () => {
    for (const provider of ["google", "microsoft"] as const) {
      const dashboard = routedDashboard(provider);
      const readiness = deriveWorkspaceReadiness(
        dashboard,
        providerConnections(provider),
      );

      expect(readiness.complete).toBe(true);
      expect(readiness.completedStages).toBe(4);
      expect(readiness.primaryAction).toBeNull();
      expect(readiness.publishedLink?.id).toBe("link-1");
      expect(
        readiness.stages.every((stage) => stage.status === "complete"),
      ).toBe(true);
    }
  });

  it("reacts immediately when a published link becomes invalid", () => {
    const dashboard = routedDashboard("google");
    const ready = deriveWorkspaceReadiness(
      dashboard,
      providerConnections("google"),
    );
    const changed = structuredClone(dashboard);
    changed.routerLinks[0]!.questions = [];
    const regressed = deriveWorkspaceReadiness(
      changed,
      providerConnections("google"),
    );

    expect(ready.complete).toBe(true);
    expect(regressed.complete).toBe(false);
    expect(regressed.completedStages).toBe(3);
    expect(regressed.primaryAction).toEqual({
      href: "#smart-links",
      label: "Publish a Smart Link",
    });
  });
});

describe("workspace launchpad markup", () => {
  it("uses ordered semantic progress and only the first incomplete CTA", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceLaunchpad, {
        dashboard: emptyDashboard(),
        connections: providerConnections(),
      }),
    );

    expect(html).toContain("<ol");
    expect(html).toContain('aria-current="step"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('href="#reps"');
    expect(html).not.toContain("Ready workspace actions");
  });

  it("replaces setup CTA with all four complete-state actions", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceLaunchpad, {
        dashboard: routedDashboard("microsoft"),
        connections: providerConnections("microsoft"),
      }),
    );

    expect(html).toContain('aria-label="Ready workspace actions"');
    expect(html).toContain("Preview");
    expect(html).toContain("Copy link");
    expect(html).toContain('href="#handoff-scheduler"');
    expect(html).toContain('href="#email-tools"');
    expect(html).not.toContain('aria-current="step"');
  });
});
