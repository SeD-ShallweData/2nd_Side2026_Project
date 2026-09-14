"use client";

import { useEffect, useState } from "react";
import type { CommunityModerationReportListResponse, CommunityReportStatus } from "@/app/api/community/communityApiContract";
import { ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { ModerationReportCard } from "@/components/admin/ModerationReportCard";
import { REPORT_STATUS_LABELS } from "@/components/admin/moderationLabels";
import { ModerationApiError, listModerationReports } from "@/services/communityModerationClient";

type StatusFilter = CommunityReportStatus | "all";

interface LoadedList {
  key: string;
  result: CommunityModerationReportListResponse | null;
  denied: string | null;
  error: string | null;
}

const STATUS_FILTERS: StatusFilter[] = ["all", "pending", "accepted", "dismissed"];

function statusFilterLabel(filter: StatusFilter): string {
  return filter === "all" ? "전체" : REPORT_STATUS_LABELS[filter];
}

// 목록 조회 시점의 401/403은 진입 시 확인한 권한이 그 사이 바뀌었을 수 있다는 뜻이라 별도로 안내한다.
function listErrorMessage(error: ModerationApiError): { denied: string | null; message: string | null } {
  if (error.code === "AUTHENTICATION_REQUIRED") {
    return { denied: "로그인이 필요한 화면입니다. 다시 로그인해 주세요.", message: null };
  }
  if (error.code === "FORBIDDEN") {
    return { denied: "현재 계정에는 신고 관리 권한이 없습니다.", message: null };
  }
  return {
    denied: null,
    message: error.retryable
      ? "신고 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
      : error.message,
  };
}

export function ModerationReportList() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedList | null>(null);

  const requestKey = `${reloadToken}|${status}|${page}`;
  const loading = loaded?.key !== requestKey;
  const result = loading ? null : loaded?.result ?? null;
  const denied = loading ? null : loaded?.denied ?? null;
  const error = loading ? null : loaded?.error ?? null;

  useEffect(() => {
    const controller = new AbortController();
    listModerationReports(
      { status: status === "all" ? null : status, page },
      { signal: controller.signal },
    )
      .then((response) => setLoaded({ key: requestKey, result: response, denied: null, error: null }))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (caught instanceof ModerationApiError) {
          const { denied: deniedMessage, message } = listErrorMessage(caught);
          setLoaded({ key: requestKey, result: null, denied: deniedMessage, error: message });
          return;
        }
        setLoaded({
          key: requestKey,
          result: null,
          denied: null,
          error: "네트워크 문제로 신고 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        });
      });
    return () => controller.abort();
  }, [requestKey, status, page]);

  function changeStatus(next: StatusFilter) {
    setStatus(next);
    setPage(1);
  }

  function reload() {
    setReloadToken((current) => current + 1);
  }

  if (denied) {
    return (
      <div className="state-card" role="alert">
        <span className="state-icon" aria-hidden="true">!</span>
        <h2>관리자 권한이 필요한 화면입니다</h2>
        <p>{denied}</p>
      </div>
    );
  }

  return (
    <>
      <div className="community-toolbar" aria-label="신고 상태 필터">
        {STATUS_FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            className={status === item ? "is-active" : ""}
            onClick={() => changeStatus(item)}
          >
            {statusFilterLabel(item)}
          </button>
        ))}
      </div>

      <section className="community-post-list" aria-label="커뮤니티 신고 목록" aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label="신고 목록을 불러오고 있습니다." /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {result && result.total > 0 ? (
          <p className="field-help">
            전체 {result.total.toLocaleString("ko-KR")}건 · {result.page.toLocaleString("ko-KR")}/{result.total_pages.toLocaleString("ko-KR")} 페이지
          </p>
        ) : null}
        {result?.items.map((report) => (
          <ModerationReportCard key={report.report_id} report={report} onReviewed={reload} />
        ))}
        {result && result.items.length === 0 ? (
          <div className="community-empty">조건에 맞는 신고가 없습니다.</div>
        ) : null}
        {result && result.total_pages > 1 ? (
          <nav className="search-pagination" aria-label="신고 목록 페이지">
            <button type="button" className="button button-outline" disabled={result.page <= 1} onClick={() => setPage(result.page - 1)}>
              ← 이전
            </button>
            <span className="pagination-page">
              <span>{result.page.toLocaleString("ko-KR")}</span>
              <span>/ {result.total_pages.toLocaleString("ko-KR")} 페이지</span>
            </span>
            <button type="button" className="button button-outline" disabled={!result.has_more} onClick={() => setPage(result.page + 1)}>
              다음 →
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}
