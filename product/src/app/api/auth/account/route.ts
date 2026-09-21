import { NextResponse } from "next/server";
import { assertSameOriginRequest, readJsonBody } from "@/server/auth/http";
import { clearSessionCookie, getSessionTokenFromRequest } from "@/server/auth/sessionCookie";
import { deleteCurrentAccount } from "@/services/authService";
import { errorPayload } from "@/utils/errors";

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
    await deleteCurrentAccount(getSessionTokenFromRequest(request), await readJsonBody(request));
    const response = NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status, headers: { "cache-control": "no-store" } });
  }
}
