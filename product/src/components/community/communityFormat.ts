import type { CommunityCompanyContextDto } from "@/app/api/community/communityApiContract";

export function companyContextLabel(context: CommunityCompanyContextDto | null): string {
  if (!context) return "연결 사업장 없음";
  return `${context.region ?? "지역 미확인"} · ${context.industry ?? "업종 미확인"}`;
}

export function relativeTimeLabel(isoDate: string): string {
  const createdMs = new Date(isoDate).getTime();
  if (Number.isNaN(createdMs)) return "작성 시각 미확인";
  const minutes = Math.floor((Date.now() - createdMs) / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return isoDate.slice(0, 10);
}
