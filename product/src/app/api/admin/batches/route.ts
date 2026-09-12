import { NextResponse } from "next/server";
import { batchStatusService } from "@/services/batchStatusService";

export async function GET() {
  try {
    const data = await batchStatusService.getBatches();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}