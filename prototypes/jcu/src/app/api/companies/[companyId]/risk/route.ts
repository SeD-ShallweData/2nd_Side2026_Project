import { NextResponse } from "next/server";
import { getCompanyRisk } from "@/services/riskService";
import { errorPayload } from "@/utils/errors";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { companyId } = await context.params;
    return NextResponse.json(await getCompanyRisk(decodeURIComponent(companyId)));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
