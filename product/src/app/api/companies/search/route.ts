import { NextResponse } from "next/server";
import { searchCompanies } from "@/services/companyService";
import { errorPayload } from "@/utils/errors";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 10 : Number(limitValue);
    const pageValue = url.searchParams.get("page");
    const page = pageValue === null ? 1 : Number(pageValue);
    return NextResponse.json(await searchCompanies(query, limit, page));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
