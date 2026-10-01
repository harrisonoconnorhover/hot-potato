import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../../repository";

const bridgeIdentifier = z.uuid();

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await context.params;
  const parsed = bridgeIdentifier.safeParse(bridgeId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Form bridge not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const deleted = await repository.deleteRouterFormBridge(
      process.env.HOT_POTATO_ORG ?? "acme",
      parsed.data,
    );
    if (!deleted) {
      return NextResponse.json(
        { error: "Form bridge not found." },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { deleted: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Existing-form bridge delete failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "The existing-form bridge could not be deleted." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
