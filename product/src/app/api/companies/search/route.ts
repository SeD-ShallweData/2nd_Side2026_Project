import { NextResponse } from "next/server";
import { searchCompanies } from "@/services/companyService";
import { errorPayload } from "@/utils/errors";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 10 : Number(limitValue);
    return NextResponse.json(await searchCompanies(query, limit));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
