import { normalizeContractLegalBasis } from "@/domain/contractLaw";
import type { ContractItemStatus, ContractReviewResult } from "@/domain/contract";

/*
 * 계약서 진단 결과를 AI 상담으로 이어 줄 때 넘기는 요약.
 *
 * 원본 파일·추출 원문·파일명은 넣지 않는다. 규칙 엔진이 낸 항목의 분류·이름·
 * 근거 조문과 "회사에 물어볼 질문"만 담는다. 브라우저 탭(sessionStorage)에만
 * 잠시 두고, 상담 요청마다 사용자가 연결을 유지한 경우에만 보낸다. 서버는
 * 이 요약을 대화 기록에 저장하지 않는다(conversation_summaries.contract_review_summary 는 계속 null).
 *
 * 브라우저가 보낸 값은 조작될 수 있으므로 서버는 형식·길이를 다시 검사하고,
 * 근거 조문은 계약 규칙 엔진이 실제로 쓰는 조문 목록에 있는 것만 받는다.
 * 그래야 조작된 조문이 "검증된 인용"으로 답변에 들어가지 않는다.
 */

export const CONTRACT_REVIEW_CONTEXT_STORAGE_KEY = "donworry.contract_review_context.v1";
/** 진단 직후 이어 묻는 용도라 오래 두지 않는다. */
export const CONTRACT_REVIEW_CONTEXT_TTL_MS = 60 * 60 * 1000;

/**
 * 계약 규칙 엔진(integrations/contract-api/app/contract/standards.py 의 LAWS 키)이
 * 낼 수 있는 근거 조문. 정식 법률명으로 바꾼 값이다. contractReviewContext.test.ts 가
 * standards.py 와 목록이 같은지 확인한다.
 */
export const CONTRACT_RULE_LEGAL_BASES: readonly string[] = [
  "근기법 제17조", "근기법 제20조", "근기법 제21조", "근기법 제22조", "근기법 제23조",
  "근기법 제26조", "근기법 제43조", "근기법 제50조", "근기법 제53조", "근기법 제54조",
  "근기법 제55조①", "근기법 제55조②", "근기법 제56조", "근기법 제60조",
  "기간제법 제4조", "기간제법 제17조", "남녀고용평등법 제11조②",
  "최저임금법 제6조", "최저임금법 시행령 제3조", "퇴직급여법 제4조", "퇴직급여법 제8조",
].map((value) => normalizeContractLegalBasis(value) ?? value);

const ALLOWED_BASES = new Set(CONTRACT_RULE_LEGAL_BASES);
const STATUSES: readonly ContractItemStatus[] = ["detected", "missing", "review"];
const MAX_ITEMS = 30;
const MAX_QUESTIONS = 8;

export interface ContractReviewContextItem {
  status: ContractItemStatus;
  code: string;
  label: string;
  legal_basis?: string;
}

export interface ContractReviewContext {
  analysis_status: "completed" | "partial";
  items: ContractReviewContextItem[];
  suggested_questions: string[];
}

export interface StoredContractReviewContext {
  saved_at: number;
  context: ContractReviewContext;
}

/** 화면의 진단 결과를 상담용 요약으로 줄인다. mock 결과는 넘기지 않는다. */
export function toContractReviewContext(result: ContractReviewResult): ContractReviewContext | null {
  if (result.analysis_status === "mocked") return null;
  const items = [...result.detected_items, ...result.missing_items, ...result.review_items].map((item) => ({
    status: item.status,
    code: item.code,
    label: item.label,
    ...(item.legal_basis ? { legal_basis: item.legal_basis } : {}),
  }));
  return parseContractReviewContext({
    analysis_status: result.analysis_status,
    items,
    suggested_questions: result.suggested_questions,
  }) ?? null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * 요청 본문의 contract_review 를 검사한다. 형식이 맞지 않으면 undefined(무시)를 돌려준다.
 * 상담 자체를 막지 않는다 — 요약은 보조 자료이기 때문이다.
 */
export function parseContractReviewContext(value: unknown): ContractReviewContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.analysis_status !== "completed" && input.analysis_status !== "partial") return undefined;
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_ITEMS) return undefined;

  const items: ContractReviewContextItem[] = [];
  for (const raw of input.items) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (!STATUSES.includes(item.status as ContractItemStatus)) return undefined;
    const code = typeof item.code === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(item.code) ? item.code : null;
    const label = cleanText(item.label, 60);
    if (!code || !label) return undefined;
    const basis = item.legal_basis === undefined ? undefined : normalizeContractLegalBasis(cleanText(item.legal_basis, 80) ?? undefined);
    items.push({
      status: item.status as ContractItemStatus,
      code,
      label,
      // 규칙 엔진 목록에 없는 조문은 버린다. 항목 자체는 남긴다.
      ...(basis && ALLOWED_BASES.has(basis) ? { legal_basis: basis } : {}),
    });
  }

  const questions = Array.isArray(input.suggested_questions)
    ? input.suggested_questions
        .map((question) => cleanText(question, 200))
        .filter((question): question is string => question !== null)
        .slice(0, MAX_QUESTIONS)
    : [];

  return { analysis_status: input.analysis_status, items, suggested_questions: questions };
}

export function contractReviewCounts(context: ContractReviewContext): Record<ContractItemStatus, number> {
  return {
    detected: context.items.filter((item) => item.status === "detected").length,
    missing: context.items.filter((item) => item.status === "missing").length,
    review: context.items.filter((item) => item.status === "review").length,
  };
}

/** 모델에 넘길 때 쓰는 근거 조문 목록. 인용 검증에도 같은 값을 쓴다. */
export function contractReviewCitations(context: ContractReviewContext | undefined): string[] {
  return [...new Set((context?.items ?? []).flatMap((item) => (item.legal_basis ? [item.legal_basis] : [])))];
}
