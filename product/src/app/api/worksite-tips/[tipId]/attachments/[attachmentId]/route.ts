import { NextResponse } from "next/server";

import { getOptionalSessionUser } from "@/services/authService";
import { getWorksiteTipAttachment } from "@/services/worksiteTipService";
import { noStoreError } from "@/server/auth/http";
import { requireAuthenticatedUser } from "@/server/auth/permissions";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tipId: string; attachmentId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireAuthenticatedUser(
      getOptionalSessionUser(getSessionTokenFromRequest(request)),
    );
    const { tipId, attachmentId } = await context.params;
    const attachment = getWorksiteTipAttachment(tipId, attachmentId, user);
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
