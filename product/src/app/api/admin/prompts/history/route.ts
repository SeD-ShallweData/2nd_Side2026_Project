import { NextResponse } from "next/server";

import { noStoreError, noStoreJson } from "@/server/auth/http";
import { requireOperatorRequest } from "@/server/auth/inspectorAccess";
import { listPromptHistory } from "@/server/ops/opsDatabase";
import { readPromptName } from "@/server/ops/opsRoute";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireOperatorRequest(request);
    const name = readPromptName(new URL(request.url).searchParams.get("name"));
    return noStoreJson({ name, items: await listPromptHistory(name, 20) });
  } catch (error) {
    return noStoreError(error);
  }
}
