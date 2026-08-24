import { NextResponse } from "next/server";
import { repository } from "../../repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const healthy = await repository.health();
    return NextResponse.json({ status: healthy ? "ok" : "unhealthy" });
  } catch {
    return NextResponse.json({ status: "unhealthy" }, { status: 503 });
  }
}
