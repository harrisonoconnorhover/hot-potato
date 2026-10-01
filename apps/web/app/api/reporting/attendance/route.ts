import { NextResponse } from "next/server";
import { repository } from "../../../repository";
import { parseAttendanceOutcome } from "../../../reporting";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PUT(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send a valid attendance update." },
      { status: 400 },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json(
      { error: "Send a valid attendance update." },
      { status: 400 },
    );
  }
  const body = parsed as Record<string, unknown>;
  const bookingId = typeof body.bookingId === "string" ? body.bookingId : "";
  const outcome = parseAttendanceOutcome(body.outcome);
  if (!uuidPattern.test(bookingId) || !outcome) {
    return NextResponse.json(
      { error: "Choose a valid meeting and attendance outcome." },
      { status: 400 },
    );
  }

  try {
    const updated = await repository.recordBookingAttendance({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      bookingId,
      outcome,
    });
    if (!updated) {
      return NextResponse.json(
        { error: "Only completed, confirmed meetings can record attendance." },
        { status: 409 },
      );
    }
    return NextResponse.json({ updated: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Attendance could not be updated." },
      { status: 503 },
    );
  }
}
