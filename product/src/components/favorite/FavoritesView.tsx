"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { describeFavoriteError } from "@/components/favorite/favoriteErrorMessage";
import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";
import { getSession } from "@/services/authClient";
import { getFavorites, removeFavorite } from "@/services/favoriteClient";

type ViewState =
  | { status: "loading" }
  | { status: "login-required" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; items: FavoriteCompanyDto[] };

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("ko-KR");
}

export function FavoritesView() {
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    async function load() {
      try {
        const session = await getSession({ signal: controller.signal });
        if (ignore) return;
        const eligibility = getFavoriteEligibility(session);
        if (!eligibility.eligible) {
          setView({ status: eligibility.reason?.requiresLogin ? "login-required" : "forbidden" });
          return;
        }
        const result = await getFavorites({ signal: controller.signal });
        if (!ignore) setView({ status: "ready", items: result.items });
      } catch (caught) {
        if (ignore || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setView({ status: "error", message: describeFavoriteError(caught) });
      }
    }

    void load();
    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  async function handleRemove(companyId: string) {
    setRemoveError(null);
    setRemovingId(companyId);
    try {
      await removeFavorite(companyId);
      setView((current) =>
        current.status === "ready"
          ? { status: "ready", items: current.items.filter((item) => item.company_id !== companyId) }
          : current,
      );
    } catch (caught) {
      setRemoveError(describeFavoriteError(caught));
    } finally {
      setRemovingId(null);
    }
  }

  if (view.status === "loading") {
    return <LoadingSkeleton label="즐겨찾기 목록을 불러오고 있습니다." />;
  }

  if (view.status === "login-required") {
    return (
      <EmptyState
        title="로그인이 필요합니다"
        description="즐겨찾기는 로그인한 사용자만 사용할 수 있습니다."
        action={
          <Link href="/login?next=%2Ffavorites" className="button button-dark">
            로그인하러 가기
          </Link>
        }
      />
    );
  }

  if (view.status === "forbidden") {
    return (
      <EmptyState
        title="일반 사용자 전용 기능입니다"
        description="즐겨찾기는 구직자·근로자 계정에서만 사용할 수 있습니다."
      />
    );
  }

  if (view.status === "error") {
    return <ErrorState message={view.message} onRetry={() => window.location.reload()} />;
  }

  if (view.items.length === 0) {
    return (
      <EmptyState
        title="저장한 관심 사업장이 없습니다"
        description="사업장을 검색해 마음에 드는 곳을 즐겨찾기에 추가해 보세요."
        action={
          <Link href="/companies" className="button button-dark">
            사업장 찾아보기
          </Link>
        }
      />
    );
  }

  return (
    <>
      <div className="company-result-list">
        {view.items.map((item) => (
          <article key={item.company_id} className="company-result-card">
            <div className="company-result-main">
              <div className="company-avatar" aria-hidden="true">
                {item.company_name.slice(0, 2)}
              </div>
              <div>
                <div className="company-title-row">
                  <h3>{item.company_name}</h3>
                </div>
                <dl className="company-meta-list">
                  <div>
                    <dt>지역</dt>
                    <dd>{item.region ?? "정보 없음"}</dd>
                  </div>
                  <div>
                    <dt>업종</dt>
                    <dd>{item.industry ?? "정보 없음"}</dd>
                  </div>
                  <div>
                    <dt>추가일</dt>
                    <dd>{formatDate(item.created_at)}</dd>
                  </div>
                </dl>
              </div>
            </div>
            <Link href={`/companies/${encodeURIComponent(item.company_id)}`} className="button button-outline">
              상세 보기
            </Link>
            <button
              type="button"
              className="button button-dark"
              disabled={removingId === item.company_id}
              onClick={() => void handleRemove(item.company_id)}
            >
              {removingId === item.company_id ? "처리 중" : "관심 해제"}
            </button>
          </article>
        ))}
      </div>
      {removeError ? (
        <p className="field-error" role="alert">
          {removeError}
        </p>
      ) : null}
    </>
  );
}
