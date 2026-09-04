import type { NextResponse } from "next/server";

import { getSessionResponse } from "@/services/authService";
import { noStoreError, noStoreJson } from "@/server/auth/http";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    return noStoreJson(await getSessionResponse(getSessionTokenFromRequest(request)));
  } catch (error) {
    return noStoreError(error);
  }
}
