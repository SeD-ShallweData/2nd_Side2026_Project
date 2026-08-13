import { NextResponse } from "next/server";
import { getCompanyFilterOptions } from "@/services/companyService";
import { errorPayload } from "@/utils/errors";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getCompanyFilterOptions());
  } catch (error) {
    const payload = errorPayload(error);
    return NextResponse.json(payload.body, { status: payload.status });
  }
}
