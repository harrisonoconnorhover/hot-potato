import { NextResponse } from "next/server";
import { repository } from "../../repository";
import { parseReportingRangeDays } from "../../reporting";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const days = parseReportingRangeDays(
      new URL(request.url).searchParams.get("days"),
    );
    const report = await repository.reporting(
      process.env.HOT_POTATO_ORG ?? "acme",
      days,
    );
    return NextResponse.json(report);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Reporting could not be loaded." },
      { status: 503 },
    );
  }
}
