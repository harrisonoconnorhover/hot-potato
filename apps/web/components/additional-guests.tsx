"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { maximumAdditionalAttendees } from "../app/booking-guests";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdditionalGuests({
  value,
  onChange,
  primaryEmail,
  disabled = false,
  tone = "light",
}: {
  value: string[];
  onChange: (value: string[]) => void;
  primaryEmail: string;
  disabled?: boolean;
  tone?: "light" | "dark";
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const primary = primaryEmail.trim().toLowerCase();
    if (!primary || !value.includes(primary)) return;
    onChange(value.filter((email) => email !== primary));
  }, [onChange, primaryEmail, value]);

  function addDraft() {
    const candidates = draft
      .split(/[;,]/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (candidates.length === 0) {
      setError("Enter a guest email address.");
      return;
    }
    const invalid = candidates.find(
      (email) => email.length > 320 || !emailPattern.test(email),
    );
    if (invalid) {
      setError(`Check the email address: ${invalid}`);
      return;
    }
    const primary = primaryEmail.trim().toLowerCase();
    if (primary && candidates.includes(primary)) {
      setError("The primary booker is already invited.");
      return;
    }
    const next = [...new Set([...value, ...candidates])];
    if (next.length > maximumAdditionalAttendees) {
      setError(`You can invite up to ${maximumAdditionalAttendees} guests.`);
      return;
    }
    onChange(next);
    setDraft("");
    setError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addDraft();
  }

  return (
    <div className={`guest-picker guest-picker--${tone}`}>
      <div className="guest-picker__heading">
        <label htmlFor={inputId}>Invite guests</label>
        <span>
          {value.length}/{maximumAdditionalAttendees}
        </span>
      </div>
      <p id={helpId}>
        Optional. They receive the calendar invite; their availability is not
        checked.
      </p>
      {value.length > 0 && (
        <ul aria-label="Additional guests">
          {value.map((email) => (
            <li key={email}>
              <span>{email}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${email}`}
                onClick={() => onChange(value.filter((item) => item !== email))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < maximumAdditionalAttendees && (
        <div className="guest-picker__entry">
          <input
            id={inputId}
            type="email"
            multiple
            inputMode="email"
            autoComplete="off"
            maxLength={1_604}
            disabled={disabled}
            aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
            placeholder="colleague@company.com"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            onBlur={(event) => {
              if (
                (event.relatedTarget as HTMLElement | null)?.dataset
                  .guestAdd === "true"
              ) {
                return;
              }
              if (draft.trim()) addDraft();
            }}
          />
          <button
            type="button"
            data-guest-add="true"
            disabled={disabled}
            onClick={addDraft}
          >
            Add
          </button>
        </div>
      )}
      {error && (
        <p className="guest-picker__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
