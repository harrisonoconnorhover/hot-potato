import { validateTimezone } from "./render.js";

export type EmailTimezoneOption = {
  value: string;
  label: string;
};

const commonEmailTimezoneOptions = Object.freeze([
  { value: "UTC", label: "UTC" },
  { value: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { value: "America/Vancouver", label: "Pacific — Vancouver" },
  { value: "America/Phoenix", label: "Mountain — Phoenix" },
  { value: "America/Denver", label: "Mountain — Denver" },
  { value: "America/Chicago", label: "Central — Chicago" },
  { value: "America/Mexico_City", label: "Central — Mexico City" },
  { value: "America/New_York", label: "Eastern — New York" },
  { value: "America/Toronto", label: "Eastern — Toronto" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Dublin", label: "Dublin" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Africa/Johannesburg", label: "Johannesburg" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "India — Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Perth", label: "Perth" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
] satisfies readonly EmailTimezoneOption[]);

export function emailTimezoneLabel(timezone: string): string {
  const safe = validateTimezone(timezone);
  return (
    commonEmailTimezoneOptions.find((option) => option.value === safe)?.label ??
    safe.replaceAll("_", " ").replaceAll("/", " / ")
  );
}

export function emailTimezoneOptions(
  preferredTimezone = "UTC",
): EmailTimezoneOption[] {
  let preferred = "UTC";
  try {
    preferred = validateTimezone(preferredTimezone);
  } catch {
    // An invalid device preference must not make the compose tool unusable.
  }
  const options = commonEmailTimezoneOptions.map((option) => ({ ...option }));
  if (!options.some((option) => option.value === preferred)) {
    options.unshift({ value: preferred, label: emailTimezoneLabel(preferred) });
  }
  return options;
}
