import { NextResponse } from "next/server";
import { getCompanyFilterOptions } from "@/services/companyService";
import { errorPayload } from "@/utils/errors";
import { assertPublicRateLimit } from "@/server/publicRateLimit";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertPublicRateLimit(request, "company_search");
    return NextResponse.json(await getCompanyFilterOptions());
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
