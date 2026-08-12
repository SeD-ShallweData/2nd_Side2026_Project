import {
  LlmCallError,
  OpenAICompatibleChatClient,
} from "@/adapters/real/OpenAICompatibleChatClient";
import type {
  InspectorBatchMeta,
  InspectorChatRequest,
  InspectorChatResponse,
  InspectorCompanyDetail,
  InspectorOverview,
  InspectorProviderResult,
  InspectorQueueItem,
  InspectorQueueGrade,
  InspectorRecentMessage,
  InspectorSearchResponse,
} from "@/domain/inspector";
import {
  INSPECTOR_OUTPUT_GUARDRAILS,
  hasUnverifiedCitation,
  scanRules,
} from "@/server/guardrails";
import { getLlmProviderConfigs, getLlmTimeoutMs } from "@/server/llmConfig";
import { loadPrompt, withRuntimeContext } from "@/server/promptLoader";
import { queryReadOnly } from "@/server/postgres";
import { retrieveLaborLawContext } from "@/services/ragService";
import { ServiceError } from "@/utils/errors";

interface BatchRow {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  ingested_at: string;
  n_scored: number;
  n_queue: number;
  n_safe: number;
}

interface CountRow {
  grade: string;
  count: number;
}

interface QueueRow {
  firm_id: string;
  name: string;
  sido: string | null;
  industry: string | null;
  rank: number;
  grade: string;
  risk_full: number | null;
  reasons: string[] | null;
}

interface SearchRow {
  firm_id: string;
  name: string;
  biz_no: string;
  sido: string | null;
  industry: string | null;
}

interface DetailRow extends SearchRow {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  ingested_at: string;
  risk_full: number | null;
  n_months: number | null;
  n_green: number | null;
  g1_employment_stable: boolean | null;
  g2_payment_faithful: boolean | null;
  g3_payroll_stable: boolean | null;
  g4_workforce_kept: boolean | null;
  g5_age_3y: boolean | null;
  g6_low_volatility: boolean | null;
  wage_exclusion: boolean | null;
  tax_exclusion: boolean | null;
  rank: number | null;
  grade: string | null;
  reasons: string[] | null;
  arrears_history: boolean | null;
  already_disclosed: boolean | null;
}

interface SafetyRow {
  target_week_start: string;
  target_week_end: string;
  provisional_population_priority_band: string;
  model_name: string | null;
  model_version: string | null;
  temporal_status: string;
}

const GRADES: InspectorQueueGrade[] = ["긴급", "우선", "주의", "관찰"];
const EMPTY_USAGE = {
  prompt_tokens: null,
  completion_tokens: null,
  total_tokens: null,
  cached_tokens: null,
  reasoning_tokens: null,
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeCompanyId(companyId: string): string {
  const normalized = companyId.trim();
  if (!normalized || normalized.length > 64) {
    throw new ServiceError("INVALID_COMPANY_ID", "사업장 식별값을 확인해 주세요.", 400, false);
  }
  return normalized;
}

function asBatch(row: BatchRow | DetailRow): InspectorBatchMeta {
  return {
    batch_id: row.batch_id,
    data_as_of: row.data_as_of,
    target_month: row.target_month,
    model_version: row.model_version,
    ingested_at: row.ingested_at,
  };
}

function asQueueItem(row: QueueRow): InspectorQueueItem {
  return {
    company_id: row.firm_id,
    company_name: row.name,
    region: row.sido,
    industry: row.industry,
    rank: row.rank,
    grade: row.grade as InspectorQueueGrade,
    model_score: row.risk_full,
    reasons: row.reasons ?? [],
  };
}

export async function getInspectorOverview(limit = 8): Promise<InspectorOverview> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ServiceError("VALIDATION_ERROR", "조회 개수를 확인해 주세요.", 400, false);
  }

  const batches = await queryReadOnly<BatchRow>(
    `SELECT id AS batch_id,
            as_of_date::text AS data_as_of,
            target_month::text,
            model_version,
            ingested_at::text,
            n_scored,
            n_queue,
            n_safe
       FROM public.batches
      ORDER BY ingested_at DESC, id DESC
      LIMIT 1`,
  );
  const batch = batches[0];
  if (!batch) {
    throw new ServiceError("INSPECTOR_DATA_NOT_FOUND", "적재된 ML 배치를 찾을 수 없습니다.", 503, true);
  }

  const [counts, topRows] = await Promise.all([
    queryReadOnly<CountRow>(
      `SELECT COALESCE(to_jsonb(q)->>'grade', to_jsonb(q)->>'queue_priority') AS grade,
              count(*)::int AS count
         FROM public.inspector_queue AS q
        WHERE batch_id = $1
        GROUP BY COALESCE(to_jsonb(q)->>'grade', to_jsonb(q)->>'queue_priority')`,
      [batch.batch_id],
    ),
    queryReadOnly<QueueRow>(
      `SELECT f.firm_id,
              f.name,
              f.sido,
              f.industry,
              q.rank,
              COALESCE(to_jsonb(q)->>'grade', to_jsonb(q)->>'queue_priority') AS grade,
              q.risk_full,
              q.reasons
         FROM public.inspector_queue AS q
         JOIN public.firms AS f ON f.firm_id = q.firm_id
        WHERE q.batch_id = $1
        ORDER BY q.rank
        LIMIT $2`,
      [batch.batch_id, limit],
    ),
  ]);

  const queueCounts = Object.fromEntries(GRADES.map((grade) => [grade, 0])) as Record<
    InspectorQueueGrade,
    number
  >;
  for (const row of counts) {
    if (GRADES.includes(row.grade as InspectorQueueGrade)) {
      queueCounts[row.grade as InspectorQueueGrade] = row.count;
    }
  }

  return {
    batch: asBatch(batch),
    totals: {
      scored: batch.n_scored,
      queue: batch.n_queue,
      safe_recommendation: batch.n_safe,
    },
    queue_counts: queueCounts,
    top_queue: topRows.map(asQueueItem),
  };
}

export async function searchInspectorCompanies(query: string, limit = 10): Promise<InspectorSearchResponse> {
  const normalized = query.trim();
  if (!normalized || normalized.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "검색어는 한 글자 이상 100자 이하여야 합니다.", 400, false);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ServiceError("VALIDATION_ERROR", "limit은 1 이상 20 이하의 정수여야 합니다.", 400, false);
  }

  const rows = await queryReadOnly<SearchRow>(
    `SELECT firm_id, name, biz_no, sido, industry
       FROM public.firms
      WHERE name ILIKE $1 ESCAPE '\\'
      ORDER BY CASE WHEN lower(name) = lower($2) THEN 0 ELSE 1 END,
               name,
               firm_id
      LIMIT $3`,
    [`%${escapeLike(normalized)}%`, normalized, limit],
  );

  return {
    query: normalized,
    items: rows.map((row) => ({
      company_id: row.firm_id,
      company_name: row.name,
      masked_business_number: row.biz_no,
      region: row.sido,
      industry: row.industry,
    })),
    total: rows.length,
  };
}

async function getSafetyContext(companyId: string): Promise<InspectorCompanyDetail["industrial_safety"]> {
  try {
    const rows = await queryReadOnly<SafetyRow>(
      `SELECT target_week_start::text,
              target_week_end::text,
              provisional_population_priority_band,
              model_name,
              model_version,
              temporal_status
         FROM industrial_safety.v_llm_firm_safety_context
        WHERE firm_id = $1
        ORDER BY target_week_start DESC
        LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      priority_band: row.provisional_population_priority_band,
      target_week_start: row.target_week_start,
      target_week_end: row.target_week_end,
      model_name: row.model_name,
      model_version: row.model_version,
      temporal_status: row.temporal_status,
      disclaimer: "임금체불 위험점수와 별개인 현장 확인 우선순위이며, 검증된 사업장 사고 확률이 아닙니다.",
    };
  } catch {
    return null;
  }
}

export async function getInspectorCompanyDetail(companyId: string): Promise<InspectorCompanyDetail> {
  const normalized = normalizeCompanyId(companyId);
  const rows = await queryReadOnly<DetailRow>(
    `WITH latest_batch AS (
       SELECT id, as_of_date, target_month, model_version, ingested_at
         FROM public.batches
        ORDER BY ingested_at DESC, id DESC
        LIMIT 1
     )
     SELECT f.firm_id,
            f.name,
            f.biz_no,
            f.sido,
            f.industry,
            b.id AS batch_id,
            b.as_of_date::text AS data_as_of,
            b.target_month::text,
            b.model_version,
            b.ingested_at::text,
            s.risk_full,
            s.n_months,
            s.n_green,
            s."g1_고용안정" AS g1_employment_stable,
            s."g2_성실납부" AS g2_payment_faithful,
            s."g3_인건비안정" AS g3_payroll_stable,
            s."g4_인력유지" AS g4_workforce_kept,
            s."g5_업력3년" AS g5_age_3y,
            s."g6_낮은변동성" AS g6_low_volatility,
            s."체불배제" AS wage_exclusion,
            s."체납배제" AS tax_exclusion,
            q.rank,
            COALESCE(to_jsonb(q)->>'grade', to_jsonb(q)->>'queue_priority') AS grade,
            q.reasons,
            q."door1_체납이력" AS arrears_history,
            q."이미_임금체불공개" AS already_disclosed
       FROM public.firms AS f
       CROSS JOIN latest_batch AS b
       LEFT JOIN public.scored_active AS s
         ON s.firm_id = f.firm_id AND s.batch_id = b.id
       LEFT JOIN public.inspector_queue AS q
         ON q.firm_id = f.firm_id AND q.batch_id = b.id
      WHERE f.firm_id = $1
      LIMIT 1`,
    [normalized],
  );
  const row = rows[0];
  if (!row) {
    throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
  }

  const reasons = row.reasons ?? [];
  const industrialSafety = await getSafetyContext(normalized);
  return {
    company: {
      company_id: row.firm_id,
      company_name: row.name,
      masked_business_number: row.biz_no,
      region: row.sido,
      industry: row.industry,
    },
    batch: asBatch(row),
    wage_risk: {
      status: row.risk_full === null ? "insufficient_data" : "scored",
      model_score: row.risk_full,
      score_interpretation: "relative_model_score_not_probability",
      rank: row.rank,
      grade: row.grade as InspectorQueueGrade | null,
      in_inspector_queue: row.rank !== null,
      reasons,
      reasons_status: row.rank === null ? "not_in_queue" : reasons.length > 0 ? "available" : "not_provided",
      arrears_history: row.arrears_history,
      already_disclosed: row.already_disclosed,
    },
    indicators: {
      observed_months: row.n_months,
      green_count: row.n_green,
      green_flags: [
        { code: "G1", label: "고용 안정", value: row.g1_employment_stable },
        { code: "G2", label: "성실 납부", value: row.g2_payment_faithful },
        { code: "G3", label: "인건비 안정", value: row.g3_payroll_stable },
        { code: "G4", label: "인력 유지", value: row.g4_workforce_kept },
        { code: "G5", label: "업력 3년", value: row.g5_age_3y },
        { code: "G6", label: "낮은 변동성", value: row.g6_low_volatility },
      ],
      wage_exclusion: row.wage_exclusion,
      tax_exclusion: row.tax_exclusion,
    },
    industrial_safety: industrialSafety,
    limitations: [
      "모델 원점수는 실제 임금체불 확률이 아니며 순위·분위·등급으로만 해석합니다.",
      row.rank === null
        ? "최신 감독관 위험큐 상위 3,000곳에 포함되지 않아 SHAP 위험사유가 제공되지 않습니다."
        : "SHAP 위험사유는 모델 판단에 기여한 피처이며 위법 사실을 확정하지 않습니다.",
      "이 화면은 현장 확인 순서를 돕는 의사결정 보조 자료이며 처분을 자동 결정하지 않습니다.",
    ],
  };
}

function normalizeRecentMessages(value: unknown): InspectorRecentMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is InspectorRecentMessage =>
        typeof item === "object" &&
        item !== null &&
        ((item as InspectorRecentMessage).role === "user" || (item as InspectorRecentMessage).role === "assistant") &&
        typeof (item as InspectorRecentMessage).content === "string",
    )
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) }));
}

export function parseInspectorChatRequest(value: unknown): InspectorChatRequest {
  const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const companyId = typeof input.company_id === "string" ? normalizeCompanyId(input.company_id) : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!companyId) {
    throw new ServiceError("VALIDATION_ERROR", "분석할 사업장을 먼저 선택해 주세요.", 400, false);
  }
  if (!message || message.length > 2_000) {
    throw new ServiceError("VALIDATION_ERROR", "질문은 한 글자 이상 2,000자 이하여야 합니다.", 400, false);
  }
  if (input.confirm_external_context !== true) {
    throw new ServiceError(
      "EXTERNAL_CONTEXT_CONSENT_REQUIRED",
      "외부 LLM에 전달되는 내부 분석자료를 확인하고 전송에 동의해 주세요.",
      400,
      false,
    );
  }
  return {
    company_id: companyId,
    message,
    recent_messages: normalizeRecentMessages(input.recent_messages),
    confirm_external_context: true,
  };
}

function fallbackAnswer(detail: InspectorCompanyDetail): string {
  const queue = detail.wage_risk.in_inspector_queue
    ? `감독관 위험큐 ${detail.wage_risk.rank?.toLocaleString("ko-KR")}위, ${detail.wage_risk.grade} 등급입니다.`
    : "최신 감독관 위험큐 상위 3,000곳에는 포함되지 않았습니다.";
  const score = detail.wage_risk.model_score === null
    ? "관측 이력이 부족해 모델 원점수가 산출되지 않았습니다. 이는 0점과 다릅니다."
    : `모델 원점수는 ${detail.wage_risk.model_score.toFixed(4)}입니다. 이 값은 실제 체불 확률이 아닙니다.`;
  const reasons = detail.wage_risk.reasons.length > 0
    ? `모델 기여 사유는 ${detail.wage_risk.reasons.join(", ")}입니다. 사실 확정이 아니라 현장 확인 항목으로만 사용해야 합니다.`
    : "제공된 SHAP 위험사유는 없습니다. 사유를 추정해서는 안 됩니다.";
  return `${detail.company.company_name}의 최신 내부 자료를 요약합니다. ${queue} ${score} ${reasons}\n\n현장 확인 전에는 사업장 식별, 기준월과 예측 대상월, 임금대장·근로계약서·지급내역 등 원자료를 별도로 대조하세요.`;
}

function buildInspectorSystemPrompt(detail: InspectorCompanyDetail, rag: Awaited<ReturnType<typeof retrieveLaborLawContext>>): string {
  const minimizedContext = {
    company_name: detail.company.company_name,
    region: detail.company.region,
    industry: detail.company.industry,
    batch: {
      data_as_of: detail.batch.data_as_of,
      target_month: detail.batch.target_month,
      model_version: detail.batch.model_version,
      ingested_at: detail.batch.ingested_at,
    },
    wage_risk: detail.wage_risk,
    indicators: {
      observed_months: detail.indicators.observed_months,
      green_count: detail.indicators.green_count,
      green_flags: detail.indicators.green_flags,
    },
    industrial_safety: detail.industrial_safety,
    limitations: detail.limitations,
  };
  return withRuntimeContext(loadPrompt("inspector/system"), [
    `최소화된 사업장 내부 컨텍스트(JSON): ${JSON.stringify(minimizedContext)}`,
    `retrieval_status: ${rag.status}`,
    `retrieved_labor_law(JSON): ${JSON.stringify(rag.documents.map((document) => ({ citation: document.citation, content: document.content })))}`,
  ]);
}

export function inspectorGuardrailHits(answer: string, ragStatus: "matched" | "no_match" | "unavailable"): string[] {
  const hits = scanRules(answer, INSPECTOR_OUTPUT_GUARDRAILS);
  if (hasUnverifiedCitation(answer, ragStatus)) {
    hits.add("UNVERIFIED_LAW_CITATION");
  }
  return [...hits];
}

export async function sendInspectorChatMessage(value: unknown): Promise<InspectorChatResponse> {
  const request = parseInspectorChatRequest(value);
  const [detail, rag] = await Promise.all([
    getInspectorCompanyDetail(request.company_id),
    retrieveLaborLawContext(request.message),
  ]);
  const fallback = fallbackAnswer(detail);
  const configs = getLlmProviderConfigs();
  const client = new OpenAICompatibleChatClient(fetch, getLlmTimeoutMs());
  const messages = [
    { role: "system" as const, content: buildInspectorSystemPrompt(detail, rag) },
    ...request.recent_messages.map((message) => ({ role: message.role, content: message.content })),
    { role: "user" as const, content: request.message },
  ];

  const results = await Promise.all(
    configs.map(async (config): Promise<InspectorProviderResult> => {
      try {
        const completion = await client.complete(config, messages);
        const guardrailHits = inspectorGuardrailHits(completion.answer, rag.status);
        const replaced = guardrailHits.length > 0;
        return {
          provider: config.id,
          provider_label: config.label,
          model: completion.model,
          status: replaced ? "guardrail_replaced" : "success",
          answer: replaced ? fallback : completion.answer,
          limitations: [
            "AI 답변은 조사·법률 판단·행정처분을 대신하지 않습니다.",
            rag.status === "matched"
              ? "표시된 공식 검색 근거와 사업장 원자료를 함께 대조해야 합니다."
              : "직접 연결된 공식 노동법 검색 근거가 없어 법령 내용은 별도로 확인해야 합니다.",
            ...(replaced ? [`정책 위반 표현(${guardrailHits.join(", ")})이 감지되어 DB 기반 요약으로 교체했습니다.`] : []),
          ],
          metrics: { latency_ms: completion.latencyMs, usage: completion.usage },
        };
      } catch (error) {
        const normalized = error instanceof LlmCallError
          ? error
          : new LlmCallError("LLM_UNKNOWN_ERROR", `${config.label} 호출 중 오류가 발생했습니다.`, true, 0);
        return {
          provider: config.id,
          provider_label: config.label,
          model: config.model,
          status: "fallback",
          answer: fallback,
          limitations: [
            "해당 모델 API가 실패하여 DB 기반 내부 요약으로 대체했습니다.",
            "AI 답변은 조사·법률 판단·행정처분을 대신하지 않습니다.",
          ],
          metrics: { latency_ms: normalized.latencyMs, usage: EMPTY_USAGE },
          error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
        };
      }
    }),
  );

  return {
    comparison_id: `ins_${crypto.randomUUID()}`,
    company_id: detail.company.company_id,
    completed_at: new Date().toISOString(),
    fair_comparison: { concurrent: true, same_context: true, same_retrieval: true },
    rag_status: rag.status,
    sources: rag.status === "matched" ? rag.documents.map((document) => document.source) : [],
    results,
  };
}
