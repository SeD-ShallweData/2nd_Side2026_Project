/*
 * 번역 경로의 공통 계약(언어 지원 2·3단계).
 *
 * 상담 모델(Solar Pro 3)은 매번 달라지는 문장에만 쓴다: 상담 질문(입구), 상담 답변(출구), 현장 제보.
 * 화면 문구·긴급 문구·계약서 판정 문구는 고정 사전을 쓰고 이 경로를 타지 않는다.
 * 구현은 services/translationService.ts 에 있다.
 */

import type { ImplementedForeignLocale } from "@/i18n/locales";

/**
 * chat_question: 상담 질문(외국어 → 한국어), chat_answer: 검증한 상담 답변(한국어 → 외국어),
 * chat_labels: 답변 카드의 한계 문구·다음 행동 이름(한국어 → 외국어, 번호 목록 한 번에),
 * worksite_tip: 현장 제보(외국어 → 한국어).
 */
export type TranslationPurpose = "chat_question" | "chat_answer" | "chat_labels" | "worksite_tip";

export interface TranslationRequest {
  text: string;
  /** "ko" 또는 구현 외국어. 입구·제보는 외국어 → ko, 출구는 ko → 외국어. */
  from: "ko" | ImplementedForeignLocale;
  to: "ko" | ImplementedForeignLocale;
  purpose: TranslationPurpose;
}

export type TranslationResult =
  | { ok: true; text: string }
  /** 모델 미설정·시간 초과·보존 검사 실패. 호출한 쪽이 원문(또는 한국어 답변)으로 대체한다. */
  | { ok: false; reason: "unconfigured" | "timeout" | "provider_error" | "preservation_failed" };

export type Translator = (request: TranslationRequest) => Promise<TranslationResult>;
