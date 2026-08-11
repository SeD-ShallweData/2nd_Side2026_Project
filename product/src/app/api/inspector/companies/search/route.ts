import { NextResponse } from "next/server";
import { searchInspectorCompanies } from "@/services/inspectorService";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 10 : Number(limitValue);
    return NextResponse.json(await searchInspectorCompanies(query, limit), {
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
