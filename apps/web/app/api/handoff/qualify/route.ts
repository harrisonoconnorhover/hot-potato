import { qualifyHandoffRequest } from "../../../handoff-api";
import { handoffDependencies } from "../../../handoff-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return qualifyHandoffRequest(request, handoffDependencies());
}
