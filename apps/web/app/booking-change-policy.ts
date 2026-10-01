export function bookingChangeIsOpen(
  allowedUntil: string | null,
  now = Date.now(),
): boolean {
  if (allowedUntil === null) return true;
  const deadline = new Date(allowedUntil).getTime();
  return Number.isFinite(deadline) && now < deadline;
}
