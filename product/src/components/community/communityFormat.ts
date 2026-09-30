import type { CommunityCompanyContextDto } from "@/app/api/community/communityApiContract";
import { format, type MessageShape } from "@/i18n/defineMessages";
import { communityMessages } from "@/i18n/messages/community";

export type CommunityFormatLabels = MessageShape<typeof communityMessages.ko>["format"];

// 관리자 화면처럼 라벨을 넘기지 않는 호출부는 지금처럼 한국어로 그린다.
const DEFAULT_LABELS: CommunityFormatLabels = communityMessages.ko.format;

/*
 * 게시글 작성 폼에 아직 사업장 선택 UI가 없어 company_context는 현재 항상
 * null이다. "연결 사업장 없음"을 매번 찍는 대신, 값이 있을 때만 표시한다.
 */
export function companyContextLabel(
  context: CommunityCompanyContextDto | null,
  labels: CommunityFormatLabels = DEFAULT_LABELS,
): string | null {
  if (!context) return null;
  return `${context.region ?? labels.regionUnknown} · ${context.industry ?? labels.industryUnknown}`;
}

export function relativeTimeLabel(isoDate: string, labels: CommunityFormatLabels = DEFAULT_LABELS): string {
  const createdMs = new Date(isoDate).getTime();
  if (Number.isNaN(createdMs)) return labels.timeUnknown;
  const minutes = Math.floor((Date.now() - createdMs) / 60_000);
  if (minutes < 1) return labels.justNow;
  if (minutes < 60) return format(labels.minutesAgo, { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format(labels.hoursAgo, { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return format(labels.daysAgo, { count: days });
  return isoDate.slice(0, 10);
}
