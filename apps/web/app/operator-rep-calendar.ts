import { NextResponse } from "next/server";
import {
  operatorSessionForRequest,
  requestHasOperatorOrigin,
} from "./operator-session";
import { repository } from "./repository";

const noStoreHeaders = { "cache-control": "no-store" };

export async function operatorRepCalendarForRequest(
  request: Request,
  repId: string,
  requireOrigin = false,
): Promise<
  | {
      identity: NonNullable<
        Awaited<ReturnType<typeof operatorSessionForRequest>>
      >;
      response?: never;
    }
  | { identity?: never; response: NextResponse }
> {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return {
      response: NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      ),
    };
  }
  if (requireOrigin && !requestHasOperatorOrigin(request)) {
    return {
      response: NextResponse.json(
        { error: "This calendar update was not accepted." },
        { status: 403, headers: noStoreHeaders },
      ),
    };
  }
  try {
    const allowed = await repository.operatorCanManageRepCalendar({
      organizationId: identity.organizationId,
      operatorId: identity.operatorId,
      repId,
    });
    if (!allowed) {
      return {
        response: NextResponse.json(
          {
            error:
              "You can manage only the representative calendar assigned to your login.",
          },
          { status: 403, headers: noStoreHeaders },
        ),
      };
    }
    return { identity };
  } catch (error) {
    console.error(
      "Representative calendar authorization failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return {
      response: NextResponse.json(
        { error: "Calendar authorization is temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      ),
    };
  }
}
