import "server-only";

import type {
  ContractItem,
  ContractItemStatus,
  ContractReviewProvider,
  ContractReviewRequest,
  ContractReviewResult,
} from "@/domain/contract";
import { normalizeContractLegalBasis } from "@/domain/contractLaw";
import { markErrorLogged, ServiceError, takeApiErrorLogSlot } from "@/utils/errors";
import { redactErrorText } from "@/utils/redactErrorText";

interface CshFinding {
  code?: unknown;
  level?: unknown;
  title?: unknown;
  message?: unknown;
  law?: unknown;
  detail?: unknown;
  evidence?: unknown;
  fix?: unknown;
}

interface CshReviewResponse {
  ok?: unknown;
  error?: unknown;
  reason?: unknown;
  message?: unknown;
  review_id?: unknown;
  filename?: unknown;
  verdict?: { headline?: unknown; findings?: unknown };
}

const FINDING_LEVELS = ["violation", "check", "ok", "excluded"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutMs(): number {
  const value = Number(process.env.CONTRACT_TIMEOUT_MS ?? 240_000);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 300_000) : 240_000;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/*
 * 계약서 분석 서비스(contract-api)가 돌려준 오류 문구는 화면에 그대로 싣지 않는다.
 *
 * 상류 문구에는 Upstage·SKT 의 HTTP 오류 본문, requests 예외 문자열(상류 호스트·주소·타임아웃),
 * 파일 경로, 환경변수 이름이 섞여 올 수 있다. 사용자에게는 아래 허용목록의 고정 문구만 보여 주고,
 * 원문은 정리(redactErrorText)해서 서버 로그에만 남긴다. 이 ServiceError 는 상담의 계약서 도구
 * 결과(toolDispatcher)로도 나가므로, 모델에게도 고정 문구만 전달된다.
 *
 * 입력 문제로 볼 수 있는 400 만 앞부분 문구로 알아보고 구체적으로 안내한다. contract-api 의
 * 문구가 바뀌면 여기서 알아보지 못하고 일반 안내로 떨어질 뿐, 원문이 새지는 않는다.
 */
const NOT_A_CONTRACT_MESSAGE =
  "올려주신 문서에서 근로계약서로 볼 만한 내용을 찾지 못했습니다. 근로계약서 원본(사진·스캔본도 가능)을 올려 주세요.";

const KNOWN_UPSTREAM_INPUT_ERRORS: ReadonlyArray<{
  prefix: string;
  code: string;
  message: string;
  status: number;
}> = [
  {
    prefix: "빈 파일입니다",
    code: "CONTRACT_FILE_EMPTY",
    message: "빈 파일은 분석할 수 없습니다. 계약서 파일을 다시 선택해 주세요.",
    status: 400,
  },
  {
    prefix: "계약서 파일이 없습니다",
    code: "CONTRACT_FILE_REQUIRED",
    message: "계약서 파일을 받지 못했습니다. 파일을 다시 선택해 주세요.",
    status: 400,
  },
  {
    prefix: "파일이 너무 큽니다",
    code: "FILE_TOO_LARGE",
    message: "파일은 15MB 이하만 업로드할 수 있습니다.",
    status: 413,
  },
  {
    prefix: "지원하지 않는 형식입니다",
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "PDF, PNG, JPG 파일만 업로드할 수 있습니다. 파일 확장자를 확인해 주세요.",
    status: 415,
  },
  {
    prefix: "문서에서 글자를 찾지 못했습니다",
    code: "CONTRACT_TEXT_NOT_FOUND",
    message: "문서에서 글자를 찾지 못했습니다. 빈 페이지이거나 해상도가 너무 낮을 수 있습니다.",
    status: 422,
  },
];

function upstreamText(payload: CshReviewResponse): string | undefined {
  return string(payload.message) ?? string(payload.error);
}

function upstreamReason(payload: CshReviewResponse): string | null {
  return typeof payload.reason === "string" ? payload.reason.slice(0, 40) : null;
}

/*
 * 상류 원문은 여기서만 남긴다. 응답 본문과 화면에는 싣지 않는다. 남겼으면 true 를 돌려준다.
 * 장애 때는 요청마다 같은 줄이 쌓이므로 5xx 기록과 같은 속도 상한(utils/errors.ts)을 거친다.
 */
function logUpstreamFailure(httpStatus: number, payload: CshReviewResponse): boolean {
  if (!takeApiErrorLogSlot()) return false;
  const text = upstreamText(payload);
  console.error(JSON.stringify({
    event: "contract_upstream_failed",
    http_status: httpStatus,
    reason: upstreamReason(payload),
    upstream: text ? redactErrorText(text) : null,
  }));
  return true;
}

function publicContractFailure(httpStatus: number, payload: CshReviewResponse): ServiceError {
  if (payload.reason === "not_a_contract") {
    // 사용자가 다른 문서를 올린 경우다. 장애가 아니므로 기록하지 않는다.
    return new ServiceError("NOT_A_CONTRACT", NOT_A_CONTRACT_MESSAGE, 422, true);
  }

  const text = upstreamText(payload);
  const known = httpStatus === 400 && text
    ? KNOWN_UPSTREAM_INPUT_ERRORS.find((entry) => text.startsWith(entry.prefix))
    : undefined;
  if (known) {
    // 빈 파일·형식·크기·글자 없음은 사용자 입력 문제라 장애 기록을 남기지 않는다(다른 4xx 와 같다).
    // 로그인 사용자는 계약서 분석 공개 한도에서 빠지므로, 남기면 같은 파일을 되풀이해 올려 로그를
    // 불릴 수 있다.
    return new ServiceError(known.code, known.message, known.status, false);
  }

  const error = httpStatus === 503
    ? new ServiceError(
        "CONTRACT_PROVIDER_UNAVAILABLE",
        "계약서 분석 서비스를 지금 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        503,
        true,
      )
    : new ServiceError(
        "CONTRACT_ANALYSIS_FAILED",
        "계약서를 분석하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        502,
        true,
      );
  // 원문을 남겼으면 표시해 둔다. errorPayload 는 원문 없이 request_id·코드만 한 줄 남긴다.
  return logUpstreamFailure(httpStatus, payload) ? markErrorLogged(error) : error;
}

function invalidUpstreamResponse(): ServiceError {
  return new ServiceError(
    "CONTRACT_ANALYSIS_INVALID_RESPONSE",
    "계약서 분석 서비스가 올바른 결과 형식을 반환하지 않았습니다.",
    502,
    true,
  );
}

function itemStatus(finding: CshFinding): ContractItemStatus {
  const code = string(finding.code) ?? "";
  if (finding.level === "ok") return "detected";
  if (finding.level === "violation" && /required|written|missing/.test(code)) return "missing";
  return "review";
}

function toItem(value: unknown): ContractItem | null {
  if (!isRecord(value)) return null;
  const finding = value as CshFinding;
  const code = string(finding.code);
  const label = string(finding.title);
  const description = string(finding.message);
  if (
    !code ||
    !label ||
    !description ||
    !FINDING_LEVELS.includes(finding.level as (typeof FINDING_LEVELS)[number]) ||
    !optionalStringField(finding.law) ||
    !optionalStringField(finding.detail) ||
    !optionalStringField(finding.evidence) ||
    !optionalStringField(finding.fix)
  ) {
    return null;
  }
  return {
    code,
    label,
    status: itemStatus(finding),
    description: [description, string(finding.detail), string(finding.fix)].filter(Boolean).join("\n"),
    legal_basis: normalizeContractLegalBasis(string(finding.law)),
    extracted_text: string(finding.evidence),
  };
}

export class RealContractReviewProvider implements ContractReviewProvider {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async review(request: ContractReviewRequest): Promise<ContractReviewResult> {
    const baseUrl = process.env.CONTRACT_ANALYSIS_URL?.trim();
    if (!baseUrl) {
      throw new ServiceError("CONTRACT_PROVIDER_UNAVAILABLE", "계약서 분석 서비스 주소가 설정되지 않았습니다.", 503, true);
    }
    if (!request.file) {
      throw new ServiceError("CONTRACT_FILE_REQUIRED", "실제 분석에는 PDF 또는 이미지 파일이 필요합니다.", 400, false);
    }
    const internalToken = process.env.CONTRACT_INTERNAL_TOKEN?.trim();
    if (!internalToken) {
      throw new ServiceError(
        "CONTRACT_PROVIDER_UNAVAILABLE",
        "계약서 분석 서비스 내부 인증이 설정되지 않았습니다.",
        503,
        true,
      );
    }

    const form = new FormData();
    form.append("file", request.file, request.file.name);
    form.append("ocr", "auto");

    let response: Response;
    try {
      response = await this.fetchFn(`${baseUrl.replace(/\/$/, "")}/api/contract/review`, {
        method: "POST",
        headers: { Authorization: `Bearer ${internalToken}` },
        body: form,
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs())])
          : AbortSignal.timeout(timeoutMs()),
        cache: "no-store",
      });
    } catch {
      throw new ServiceError("CONTRACT_PROVIDER_UNAVAILABLE", "계약서 분석 서비스에 연결하지 못했습니다.", 503, true);
    }

    const rawPayload: unknown = await response.json().catch(() => null);
    const payload = isRecord(rawPayload) ? (rawPayload as CshReviewResponse) : {};
    if (!response.ok || payload.ok === false) {
      throw publicContractFailure(response.status, payload);
    }
    if (payload.ok !== true || !isRecord(payload.verdict)) {
      throw invalidUpstreamResponse();
    }

    const reviewId = string(payload.review_id);
    const fileName = string(payload.filename);
    const headline = string(payload.verdict.headline);
    const findings = payload.verdict.findings;
    if (!reviewId || !fileName || !headline || !Array.isArray(findings)) {
      throw invalidUpstreamResponse();
    }

    const parsedItems = findings.map(toItem);
    if (parsedItems.some((item) => item === null)) {
      throw invalidUpstreamResponse();
    }
    const items = parsedItems as ContractItem[];

    return {
      analysis_status: "completed",
      detected_items: items.filter((item) => item.status === "detected"),
      missing_items: items.filter((item) => item.status === "missing"),
      review_items: items.filter((item) => item.status === "review"),
      warnings: [headline],
      suggested_questions: items
        .filter((item) => item.status !== "detected")
        .slice(0, 5)
        .map((item) => `${item.label} 항목은 계약서 원문과 실제 근무조건이 어떻게 적용되는지 확인해 주세요.`),
      limitations: [
        "문서 추출과 규칙 검토를 돕는 결과이며 개별 사안의 최종 법률 판단을 대신하지 않습니다.",
        "확인 필요는 곧바로 위법을 뜻하지 않습니다.",
      ],
      review_id: reviewId,
      file_name: fileName,
    };
  }
}
