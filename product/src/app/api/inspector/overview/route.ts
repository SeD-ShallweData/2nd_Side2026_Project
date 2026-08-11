import { NextResponse } from "next/server";
import { getInspectorOverview } from "@/services/inspectorService";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 8 : Number(limitValue);
    return NextResponse.json(await getInspectorOverview(limit), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, {
      status: payload.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
