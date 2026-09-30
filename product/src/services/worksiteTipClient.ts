import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type {
  WorksiteTipDto,
  WorksiteTipListResponse,
  WorksiteTipReceiptDto,
} from "@/app/api/worksite-tips/worksiteTipApiContract";
import { readApiResponse } from "@/utils/clientApi";

/*
 * 응답 읽기는 공용 도우미(readApiResponse)를 쓴다. 빈 본문 502 나 HTML 오류 페이지를 받아도
 * 브라우저의 JSON 해석 오류 원문 대신 한국어 안내가 뜬다.
 */

export async function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch("/api/auth/session", { signal, cache: "no-store" });
  return readApiResponse<SessionResponse>(response);
}

export async function submitWorksiteTip(form: FormData): Promise<WorksiteTipReceiptDto> {
  const response = await fetch("/api/worksite-tips", { method: "POST", body: form });
  return readApiResponse<WorksiteTipReceiptDto>(response);
}

export async function listWorksiteTips(page: number, signal?: AbortSignal): Promise<WorksiteTipListResponse> {
  const response = await fetch(`/api/worksite-tips?page=${page}&limit=10`, {
    signal,
    cache: "no-store",
  });
  return readApiResponse<WorksiteTipListResponse>(response);
}

export async function getWorksiteTip(tipId: string): Promise<WorksiteTipDto> {
  const response = await fetch(`/api/worksite-tips/${encodeURIComponent(tipId)}`, { cache: "no-store" });
  return readApiResponse<WorksiteTipDto>(response);
}
