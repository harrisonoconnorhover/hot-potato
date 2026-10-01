import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";

const bridgeIdentifier = z.uuid();
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
} as const;

function notFound() {
  return NextResponse.json(
    { error: "Form bridge not found." },
    { status: 404, headers: corsHeaders },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await context.params;
  const parsed = bridgeIdentifier.safeParse(bridgeId);
  if (!parsed.success) return notFound();

  try {
    const config = await repository.publicRouterFormBridge(parsed.data);
    return config
      ? NextResponse.json(config, { headers: corsHeaders })
      : notFound();
  } catch (error) {
    console.error(
      "Public form bridge lookup failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return notFound();
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders, "access-control-max-age": "600" },
  });
}
