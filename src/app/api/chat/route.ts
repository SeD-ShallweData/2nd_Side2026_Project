import { NextResponse } from "next/server";
import { sendComparedChatMessage } from "@/services/chatComparisonService";
import { errorPayload } from "@/utils/errors";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    return NextResponse.json(await sendComparedChatMessage(body));
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
