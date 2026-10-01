import { NextResponse } from "next/server";
import {
  operatorRoleCanAdmin,
  operatorSessionForRequest,
} from "../../operator-session";
import { repository } from "../../repository";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: noStoreHeaders },
    );
  }
  try {
    const dashboard = await repository.dashboard(identity.organizationSlug);
    const scopedDashboard = operatorRoleCanAdmin(identity.role)
      ? dashboard
      : {
          ...dashboard,
          reps: [],
          availabilitySchedules: [],
          pools: [],
          meetingTypes: [],
          routerFormBridges: [],
        };
    return NextResponse.json(scopedDashboard, { headers: noStoreHeaders });
  } catch (error) {
    console.error(
      "Routing workspace load failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "The routing workspace could not be loaded." },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
