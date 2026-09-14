import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type {
  WorksiteTipDto,
  WorksiteTipListResponse,
  WorksiteTipReceiptDto,
} from "@/app/api/worksite-tips/worksiteTipApiContract";

interface ApiErrorPayload {
  error?: { message?: string };
  message?: string;
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | ApiErrorPayload;
  if (!response.ok) {
    const error = payload as ApiErrorPayload;
    throw new Error(error.error?.message ?? error.message ?? "요청을 처리하지 못했습니다.");
  }
  return payload as T;
}

export async function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch("/api/auth/session", { signal, cache: "no-store" });
  return readResponse<SessionResponse>(response);
}

export async function submitWorksiteTip(form: FormData): Promise<WorksiteTipReceiptDto> {
  const response = await fetch("/api/worksite-tips", { method: "POST", body: form });
  return readResponse<WorksiteTipReceiptDto>(response);
}

export async function listWorksiteTips(page: number, signal?: AbortSignal): Promise<WorksiteTipListResponse> {
  const response = await fetch(`/api/worksite-tips?page=${page}&limit=10`, {
    signal,
    cache: "no-store",
  });
  return readResponse<WorksiteTipListResponse>(response);
}

export async function getWorksiteTip(tipId: string): Promise<WorksiteTipDto> {
  const response = await fetch(`/api/worksite-tips/${encodeURIComponent(tipId)}`, { cache: "no-store" });
  return readResponse<WorksiteTipDto>(response);
}
