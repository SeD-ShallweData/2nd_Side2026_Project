import { NextResponse } from "next/server";
import { getInspectorCompanyDetail } from "@/services/inspectorService";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { companyId } = await context.params;
    return NextResponse.json(await getInspectorCompanyDetail(decodeURIComponent(companyId)), {
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
