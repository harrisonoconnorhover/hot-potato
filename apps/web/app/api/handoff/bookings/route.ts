import { bookingHandoffRequest } from "../../../handoff-api";
import { handoffDependencies } from "../../../handoff-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return bookingHandoffRequest(request, handoffDependencies());
}
