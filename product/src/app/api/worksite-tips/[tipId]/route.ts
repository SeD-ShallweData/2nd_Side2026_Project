import type { NextResponse } from "next/server";

import { getWorksiteTip } from "@/services/worksiteTipService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireInspectorRequest } from "@/server/auth/inspectorAccess";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tipId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireInspectorRequest(request);
    const { tipId } = await context.params;
    return noStoreJson(await getWorksiteTip(tipId, user));
  } catch (error) {
    return noStoreError(error);
  }
}
