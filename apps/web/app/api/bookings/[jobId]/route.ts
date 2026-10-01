import { NextResponse } from "next/server";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const jobId = Number((await context.params).jobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }
  const booking = await repository.bookingStatus(
    process.env.HOT_POTATO_ORG ?? "acme",
    jobId,
  );
  return booking
    ? NextResponse.json(booking)
    : NextResponse.json({ error: "Booking not found." }, { status: 404 });
}
