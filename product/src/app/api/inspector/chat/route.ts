import { NextResponse } from "next/server";
import { sendInspectorChatMessage } from "@/services/inspectorService";
import { errorPayload } from "@/utils/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    return NextResponse.json(await sendInspectorChatMessage(body), {
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
