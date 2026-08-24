import { NextResponse } from "next/server";
import { repository } from "../../repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dashboard = await repository.dashboard(
      process.env.HOT_POTATO_ORG ?? "acme",
    );
    return NextResponse.json(dashboard);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "The routing workspace could not be loaded." },
      { status: 503 },
    );
  }
}
