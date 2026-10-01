"use client";

import type { Dashboard, MeetingType } from "@hot-potato/db";
import { useEffect, useMemo, useState } from "react";
import { AvailabilityEditor } from "./availability-editor";
import { AvailabilityScheduleLibrary } from "./availability-schedule-library";

type MeetingTypeDraft = Omit<MeetingType, "id" | "targetName"> & {
  id?: string;
};

const bookingChangeCutoffOptions = [
  { value: null, label: "Any time" },
  { value: 0, label: "Until the meeting starts" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 120, label: "2 hours before" },
  { value: 240, label: "4 hours before" },
  { value: 720, label: "12 hours before" },
  { value: 1440, label: "1 day before" },
  { value: 2880, label: "2 days before" },
  { value: 10080, label: "1 week before" },
] as const;

function cutoffValue(value: string): number | null {
  return value === "anytime" ? null : Number(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function SchedulingSettings({
  dashboard,
  onRefresh,
}: {
  dashboard: Dashboard;
  onRefresh: () => Promise<void>;
}) {
  const reps = useMemo(() => {
    return dashboard.reps
      .filter((rep) => rep.active)
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [dashboard.reps]);
  const [meetingTypes, setMeetingTypes] = useState<MeetingTypeDraft[]>(
    dashboard.meetingTypes,
  );
  const [savingMeetingType, setSavingMeetingType] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () => setMeetingTypes(dashboard.meetingTypes),
    [dashboard.meetingTypes],
  );

  function updateMeetingType(
    index: number,
    changes: Partial<MeetingTypeDraft>,
  ) {
    setMeetingTypes((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...changes } : item,
      ),
    );
  }

  function addMeetingType() {
    const firstRep = reps[0];
    const firstPool = dashboard.pools[0];
    if (!firstRep && !firstPool) return;
    setMeetingTypes((current) => [
      ...current,
      {
        slug: "new-meeting",
        title: "New meeting",
        description: "Pick a time that works for you.",
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 60,
        bookingWindowDays: 14,
        inviteeLimitScope: "none",
        inviteeLimitCount: null,
        rescheduleCutoffMinutes: 0,
        cancelCutoffMinutes: 0,
        conferenceProvider: "none",
        zoomJoinUrl: null,
        reminderMinutes: 1440,
        active: true,
        targetType: firstRep ? "rep" : "pool",
        targetId: firstRep?.id ?? firstPool!.id,
        cohosts: [],
        cohostGroups: [],
      },
    ]);
  }

  function addCohostGroup(index: number) {
    const meetingType = meetingTypes[index]!;
    const selected = new Set(
      meetingType.cohostGroups.map((group) => group.poolId),
    );
    const pool = dashboard.pools.find(
      (candidate) =>
        !selected.has(candidate.id) &&
        !(
          meetingType.targetType === "pool" &&
          meetingType.targetId === candidate.id
        ),
    );
    if (!pool) return;
    updateMeetingType(index, {
      cohostGroups: [
        ...meetingType.cohostGroups,
        {
          poolId: pool.id,
          poolName: pool.name,
          requiredForAvailability: true,
          crmOwnerProperty: null,
        },
      ],
    });
  }

  function addCohost(index: number) {
    const meetingType = meetingTypes[index]!;
    const selected = new Set(meetingType.cohosts.map((cohost) => cohost.repId));
    const rep = reps.find(
      (candidate) =>
        !selected.has(candidate.id) &&
        !(
          meetingType.targetType === "rep" &&
          meetingType.targetId === candidate.id
        ),
    );
    if (!rep) return;
    updateMeetingType(index, {
      cohosts: [
        ...meetingType.cohosts,
        {
          repId: rep.id,
          name: rep.name,
          requiredForAvailability: true,
        },
      ],
    });
  }

  async function saveMeetingType(index: number) {
    const meetingType = meetingTypes[index]!;
    const key = meetingType.id ?? `new-${index}`;
    setSavingMeetingType(key);
    setNotice(null);
    const response = await fetch("/api/settings/meeting-types", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meetingType),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    if (!response.ok) {
      setNotice(body.error ?? "The meeting type could not be saved.");
    } else {
      setNotice("Meeting type saved.");
      await onRefresh();
    }
    setSavingMeetingType(null);
  }

  return (
    <>
      <section className="settings-card" id="meeting-types">
        <div className="card-heading">
          <div>
            <span className="section-number">12</span>
            <div>
              <h2>Meeting types</h2>
              <p>
                Control the link, team, protected time, buyer limits, change
                deadlines, video, and reminders.
              </p>
            </div>
          </div>
          <button type="button" onClick={addMeetingType}>
            Add meeting type
          </button>
        </div>
        <div className="meeting-type-grid">
          {meetingTypes.map((meetingType, index) => (
            <article
              className="meeting-type-editor"
              key={meetingType.id ?? `new-${index}`}
            >
              <div className="meeting-editor-heading">
                <div>
                  <span>{meetingType.active ? "LIVE" : "PAUSED"}</span>
                  <h3>{meetingType.title}</h3>
                  {(meetingType.bufferBeforeMinutes > 0 ||
                    meetingType.bufferAfterMinutes > 0) && (
                    <small className="meeting-buffer-summary">
                      Protected · {meetingType.bufferBeforeMinutes}m before ·{" "}
                      {meetingType.bufferAfterMinutes}m after
                    </small>
                  )}
                  {meetingType.cohosts.length +
                    meetingType.cohostGroups.length >
                    0 && (
                    <small className="meeting-team-summary">
                      Team meeting · 1 routed host +{" "}
                      {meetingType.cohosts.length +
                        meetingType.cohostGroups.length}{" "}
                      co-host roles
                    </small>
                  )}
                </div>
                {meetingType.id && (
                  <a
                    href={`/schedule/${dashboard.organization.slug}/${meetingType.slug}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview ↗
                  </a>
                )}
              </div>
              <div className="meeting-editor-fields">
                <label>
                  Name
                  <input
                    value={meetingType.title}
                    onChange={(event) => {
                      const title = event.target.value;
                      updateMeetingType(index, {
                        title,
                        ...(!meetingType.id ? { slug: slugify(title) } : {}),
                      });
                    }}
                  />
                </label>
                <label>
                  Link slug
                  <input
                    value={meetingType.slug}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        slug: slugify(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="wide-field">
                  Description
                  <textarea
                    value={meetingType.description}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        description: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Routes to
                  <select
                    value={meetingType.targetType}
                    onChange={(event) => {
                      const targetType = event.target.value as "rep" | "pool";
                      updateMeetingType(index, {
                        targetType,
                        targetId:
                          targetType === "rep"
                            ? (reps[0]?.id ?? "")
                            : (dashboard.pools[0]?.id ?? ""),
                        cohosts:
                          targetType === "rep" && reps[0]
                            ? meetingType.cohosts.filter(
                                (cohost) => cohost.repId !== reps[0]!.id,
                              )
                            : meetingType.cohosts,
                        cohostGroups:
                          targetType === "pool" && dashboard.pools[0]
                            ? meetingType.cohostGroups.filter(
                                (group) =>
                                  group.poolId !== dashboard.pools[0]!.id,
                              )
                            : meetingType.cohostGroups,
                      });
                    }}
                  >
                    <option value="rep">One representative</option>
                    <option value="pool">Routing pool</option>
                  </select>
                </label>
                <label>
                  Host
                  <select
                    value={meetingType.targetId}
                    onChange={(event) => {
                      const targetId = event.target.value;
                      updateMeetingType(index, {
                        targetId,
                        cohosts:
                          meetingType.targetType === "rep"
                            ? meetingType.cohosts.filter(
                                (cohost) => cohost.repId !== targetId,
                              )
                            : meetingType.cohosts,
                        cohostGroups:
                          meetingType.targetType === "pool"
                            ? meetingType.cohostGroups.filter(
                                (group) => group.poolId !== targetId,
                              )
                            : meetingType.cohostGroups,
                      });
                    }}
                  >
                    {(meetingType.targetType === "rep"
                      ? reps
                      : dashboard.pools
                    ).map((target) => (
                      <option value={target.id} key={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="meeting-cohosts wide-field">
                  <div className="meeting-cohosts__heading">
                    <div>
                      <h4>Co-hosts</h4>
                      <p>
                        Required calendars narrow the available times. Optional
                        co-hosts get the invite without blocking availability.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => addCohost(index)}
                      disabled={meetingType.cohosts.length >= 10}
                    >
                      Add co-host
                    </button>
                  </div>
                  {meetingType.cohosts.length === 0 ? (
                    <div className="meeting-cohosts__empty">
                      The routed host is the only required attendee.
                    </div>
                  ) : (
                    <div className="meeting-cohosts__list">
                      {meetingType.cohosts.map((cohost, cohostIndex) => {
                        const unavailableRepIds = new Set(
                          meetingType.cohosts
                            .filter((_, index) => index !== cohostIndex)
                            .map((item) => item.repId),
                        );
                        return (
                          <div
                            className="meeting-cohosts__row"
                            key={`${cohost.repId}-${cohostIndex}`}
                          >
                            <label>
                              Person
                              <select
                                value={cohost.repId}
                                onChange={(event) => {
                                  const rep = reps.find(
                                    (candidate) =>
                                      candidate.id === event.target.value,
                                  );
                                  if (!rep) return;
                                  updateMeetingType(index, {
                                    cohosts: meetingType.cohosts.map(
                                      (item, itemIndex) =>
                                        itemIndex === cohostIndex
                                          ? {
                                              ...item,
                                              repId: rep.id,
                                              name: rep.name,
                                            }
                                          : item,
                                    ),
                                  });
                                }}
                              >
                                {reps.map((rep) => (
                                  <option
                                    value={rep.id}
                                    key={rep.id}
                                    disabled={
                                      unavailableRepIds.has(rep.id) ||
                                      (meetingType.targetType === "rep" &&
                                        meetingType.targetId === rep.id)
                                    }
                                  >
                                    {rep.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Availability
                              <select
                                value={
                                  cohost.requiredForAvailability
                                    ? "required"
                                    : "optional"
                                }
                                onChange={(event) =>
                                  updateMeetingType(index, {
                                    cohosts: meetingType.cohosts.map(
                                      (item, itemIndex) =>
                                        itemIndex === cohostIndex
                                          ? {
                                              ...item,
                                              requiredForAvailability:
                                                event.target.value ===
                                                "required",
                                            }
                                          : item,
                                    ),
                                  })
                                }
                              >
                                <option value="required">
                                  Required · check calendar
                                </option>
                                <option value="optional">
                                  Optional · invite only
                                </option>
                              </select>
                            </label>
                            <button
                              type="button"
                              aria-label={`Remove ${cohost.name}`}
                              onClick={() =>
                                updateMeetingType(index, {
                                  cohosts: meetingType.cohosts.filter(
                                    (_, itemIndex) => itemIndex !== cohostIndex,
                                  ),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="meeting-cohosts wide-field">
                  <div className="meeting-cohosts__heading">
                    <div>
                      <h4>Rotating co-host roles</h4>
                      <p>
                        Assign one person fairly from each pool. Required pools
                        offer only shared free times; optional pools assign and
                        invite someone without blocking the slot. Optionally
                        write the selected person into a HubSpot contact owner
                        property after booking.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => addCohostGroup(index)}
                      disabled={
                        meetingType.cohostGroups.length >= 5 ||
                        !dashboard.pools.some(
                          (pool) =>
                            !meetingType.cohostGroups.some(
                              (group) => group.poolId === pool.id,
                            ) &&
                            !(
                              meetingType.targetType === "pool" &&
                              meetingType.targetId === pool.id
                            ),
                        )
                      }
                    >
                      Add pool role
                    </button>
                  </div>
                  {meetingType.cohostGroups.length === 0 ? (
                    <div className="meeting-cohosts__empty">
                      No rotating co-host role is assigned.
                    </div>
                  ) : (
                    <div className="meeting-cohosts__list">
                      {meetingType.cohostGroups.map((group, groupIndex) => {
                        const unavailablePoolIds = new Set(
                          meetingType.cohostGroups
                            .filter((_, index) => index !== groupIndex)
                            .map((item) => item.poolId),
                        );
                        return (
                          <div
                            className="meeting-cohosts__row has-crm-property"
                            key={`${group.poolId}-${groupIndex}`}
                          >
                            <label>
                              Pool role
                              <select
                                value={group.poolId}
                                onChange={(event) => {
                                  const pool = dashboard.pools.find(
                                    (candidate) =>
                                      candidate.id === event.target.value,
                                  );
                                  if (!pool) return;
                                  updateMeetingType(index, {
                                    cohostGroups: meetingType.cohostGroups.map(
                                      (item, itemIndex) =>
                                        itemIndex === groupIndex
                                          ? {
                                              ...item,
                                              poolId: pool.id,
                                              poolName: pool.name,
                                            }
                                          : item,
                                    ),
                                  });
                                }}
                              >
                                {dashboard.pools.map((pool) => (
                                  <option
                                    value={pool.id}
                                    key={pool.id}
                                    disabled={
                                      unavailablePoolIds.has(pool.id) ||
                                      (meetingType.targetType === "pool" &&
                                        meetingType.targetId === pool.id)
                                    }
                                  >
                                    {pool.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Availability
                              <select
                                value={
                                  group.requiredForAvailability
                                    ? "required"
                                    : "optional"
                                }
                                onChange={(event) =>
                                  updateMeetingType(index, {
                                    cohostGroups: meetingType.cohostGroups.map(
                                      (item, itemIndex) =>
                                        itemIndex === groupIndex
                                          ? {
                                              ...item,
                                              requiredForAvailability:
                                                event.target.value ===
                                                "required",
                                            }
                                          : item,
                                    ),
                                  })
                                }
                              >
                                <option value="required">
                                  Required · find one free
                                </option>
                                <option value="optional">
                                  Optional · assign and invite
                                </option>
                              </select>
                            </label>
                            <label>
                              HubSpot owner property
                              <input
                                value={group.crmOwnerProperty ?? ""}
                                placeholder="technical_owner"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                onChange={(event) =>
                                  updateMeetingType(index, {
                                    cohostGroups: meetingType.cohostGroups.map(
                                      (item, itemIndex) =>
                                        itemIndex === groupIndex
                                          ? {
                                              ...item,
                                              crmOwnerProperty:
                                                event.target.value || null,
                                            }
                                          : item,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <button
                              type="button"
                              aria-label={`Remove ${group.poolName}`}
                              onClick={() =>
                                updateMeetingType(index, {
                                  cohostGroups: meetingType.cohostGroups.filter(
                                    (_, itemIndex) => itemIndex !== groupIndex,
                                  ),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <label>
                  Duration
                  <select
                    value={meetingType.durationMinutes}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        durationMinutes: Number(event.target.value),
                      })
                    }
                  >
                    {[15, 30, 45, 60, 90, 120].map((minutes) => (
                      <option value={minutes} key={minutes}>
                        {minutes} minutes
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Preparation buffer
                  <select
                    value={meetingType.bufferBeforeMinutes}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        bufferBeforeMinutes: Number(event.target.value),
                      })
                    }
                  >
                    {[0, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((minutes) => (
                      <option value={minutes} key={minutes}>
                        {minutes === 0 ? "No buffer" : `${minutes} minutes`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Recovery buffer
                  <select
                    value={meetingType.bufferAfterMinutes}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        bufferAfterMinutes: Number(event.target.value),
                      })
                    }
                  >
                    {[0, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((minutes) => (
                      <option value={minutes} key={minutes}>
                        {minutes === 0 ? "No buffer" : `${minutes} minutes`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Video
                  <select
                    value={meetingType.conferenceProvider}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        conferenceProvider: event.target
                          .value as MeetingType["conferenceProvider"],
                      })
                    }
                  >
                    <option value="none">Calendar invitation only</option>
                    <option value="google_meet">Google Meet</option>
                    <option value="microsoft_teams">Microsoft Teams</option>
                    <option value="zoom">Zoom room link</option>
                  </select>
                </label>
                {meetingType.conferenceProvider === "zoom" && (
                  <label className="wide-field">
                    Zoom room URL
                    <input
                      type="url"
                      placeholder="https://us06web.zoom.us/j/..."
                      value={meetingType.zoomJoinUrl ?? ""}
                      onChange={(event) =>
                        updateMeetingType(index, {
                          zoomJoinUrl: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <label>
                  Minimum notice (minutes)
                  <input
                    type="number"
                    min="0"
                    value={meetingType.minimumNoticeMinutes}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        minimumNoticeMinutes: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Booking window (days)
                  <input
                    type="number"
                    min="1"
                    value={meetingType.bookingWindowDays}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        bookingWindowDays: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <div className="meeting-policy wide-field">
                  <div className="meeting-policy__heading">
                    <h4>Buyer and change policy</h4>
                    <p>
                      Stop repeat bookings and decide how late buyers may change
                      plans. Saved bookings keep the policy they started with.
                    </p>
                  </div>
                  <label>
                    Buyer booking guardrail
                    <select
                      value={meetingType.inviteeLimitScope}
                      onChange={(event) => {
                        const inviteeLimitScope = event.target
                          .value as MeetingType["inviteeLimitScope"];
                        updateMeetingType(index, {
                          inviteeLimitScope,
                          inviteeLimitCount:
                            inviteeLimitScope === "none"
                              ? null
                              : (meetingType.inviteeLimitCount ?? 1),
                        });
                      }}
                    >
                      <option value="none">Unlimited</option>
                      <option value="email">Limit each email address</option>
                      <option value="domain">
                        Limit each exact email domain
                      </option>
                    </select>
                  </label>
                  {meetingType.inviteeLimitScope !== "none" && (
                    <label>
                      Maximum active or upcoming
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={meetingType.inviteeLimitCount ?? 1}
                        onChange={(event) =>
                          updateMeetingType(index, {
                            inviteeLimitCount: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    Rescheduling closes
                    <select
                      value={
                        meetingType.rescheduleCutoffMinutes === null
                          ? "anytime"
                          : meetingType.rescheduleCutoffMinutes
                      }
                      onChange={(event) =>
                        updateMeetingType(index, {
                          rescheduleCutoffMinutes: cutoffValue(
                            event.target.value,
                          ),
                        })
                      }
                    >
                      {bookingChangeCutoffOptions.map((option) => (
                        <option
                          key={option.value ?? "anytime"}
                          value={option.value ?? "anytime"}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Cancellation closes
                    <select
                      value={
                        meetingType.cancelCutoffMinutes === null
                          ? "anytime"
                          : meetingType.cancelCutoffMinutes
                      }
                      onChange={(event) =>
                        updateMeetingType(index, {
                          cancelCutoffMinutes: cutoffValue(event.target.value),
                        })
                      }
                    >
                      {bookingChangeCutoffOptions.map((option) => (
                        <option
                          key={option.value ?? "anytime"}
                          value={option.value ?? "anytime"}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Reminder (minutes before)
                  <input
                    type="number"
                    min="0"
                    value={meetingType.reminderMinutes}
                    onChange={(event) =>
                      updateMeetingType(index, {
                        reminderMinutes: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="meeting-active-toggle">
                  <input
                    type="checkbox"
                    checked={meetingType.active}
                    onChange={(event) =>
                      updateMeetingType(index, { active: event.target.checked })
                    }
                  />
                  Public link active
                </label>
              </div>
              <button
                type="button"
                className="save-setting"
                disabled={
                  savingMeetingType === (meetingType.id ?? `new-${index}`)
                }
                onClick={() => void saveMeetingType(index)}
              >
                {savingMeetingType === (meetingType.id ?? `new-${index}`)
                  ? "Saving…"
                  : "Save meeting type"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="settings-card" id="working-hours">
        <div className="card-heading">
          <div>
            <span className="section-number">13</span>
            <div>
              <h2>Working hours</h2>
              <p>
                Set each representative’s bookable week, split shifts, and
                timezone without losing existing periods.
              </p>
            </div>
          </div>
        </div>
        <AvailabilityScheduleLibrary
          schedules={dashboard.availabilitySchedules}
          onRefresh={onRefresh}
        />
        <div className="working-hours-list">
          {reps.map((rep) => (
            <AvailabilityEditor
              key={rep.id}
              rep={rep}
              onSaved={onRefresh}
              availabilitySchedules={dashboard.availabilitySchedules}
              showIdentity
            />
          ))}
        </div>
      </section>
      {notice && (
        <div className="settings-notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
