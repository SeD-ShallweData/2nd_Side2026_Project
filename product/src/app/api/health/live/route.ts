import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { api_contract: "donworry.health.v1", status: "live" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
