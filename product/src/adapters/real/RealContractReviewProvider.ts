import type {
  ContractItem,
  ContractItemStatus,
  ContractReviewProvider,
  ContractReviewRequest,
  ContractReviewResult,
} from "@/domain/contract";
import { normalizeContractLegalBasis } from "@/domain/contractLaw";
import { ServiceError } from "@/utils/errors";

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

function upstreamMessage(payload: CshReviewResponse): string | undefined {
  return string(payload.message) ?? string(payload.error);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
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

    const form = new FormData();
    form.append("file", request.file, request.file.name);
    form.append("ocr", "auto");

    let response: Response;
    try {
      response = await this.fetchFn(`${baseUrl.replace(/\/$/, "")}/api/contract/review`, {
        method: "POST",
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
      throw new ServiceError(
        payload.reason === "not_a_contract" ? "NOT_A_CONTRACT" : "CONTRACT_ANALYSIS_FAILED",
        upstreamMessage(payload) ?? `계약서 분석 서비스가 HTTP ${response.status} 오류를 반환했습니다.`,
        payload.reason === "not_a_contract" ? 422 : 502,
        true,
      );
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
