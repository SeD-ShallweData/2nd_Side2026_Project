import { NextResponse } from "next/server";

import { getWorksiteTipAttachment } from "@/services/worksiteTipService";
import { noStoreError } from "@/server/auth/http";
import { requireInspectorRequest } from "@/server/auth/inspectorAccess";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tipId: string; attachmentId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireInspectorRequest(request);
    const { tipId, attachmentId } = await context.params;
    const attachment = await getWorksiteTipAttachment(tipId, attachmentId, user);
    return new NextResponse(attachment.bytes, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="worksite-tip-${attachmentId}"`,
        "Content-Length": String(attachment.size_bytes),
        "Content-Type": attachment.media_type,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return noStoreError(error);
  }
}
