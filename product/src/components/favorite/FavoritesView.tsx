"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { describeFavoriteError } from "@/components/favorite/favoriteErrorMessage";
import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";
import { getSession } from "@/services/authClient";
import { getFavorites, removeFavorite } from "@/services/favoriteClient";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { htmlLang, type Locale } from "@/i18n/locales";
import { favoriteMessages } from "@/i18n/messages/favorite";

type ViewState =
  | { status: "loading" }
  | { status: "login-required" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; items: FavoriteCompanyDto[] };

function formatDate(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(locale === "ko" || locale === "ko-easy" ? "ko-KR" : htmlLang(locale));
}

export function FavoritesView() {
  const locale = useLocale();
  const m = useMessages(favoriteMessages);
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
        setView({ status: "error", message: describeFavoriteError(caught, m.errors) });
      }
    }

    void load();
    return () => {
      ignore = true;
      controller.abort();
    };
    // 쉬운 한국어 사전은 렌더마다 새 객체라 의존성에 넣으면 목록을 계속 다시 부른다. 진입 시 한 번이면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setRemoveError(describeFavoriteError(caught, m.errors));
    } finally {
      setRemovingId(null);
    }
  }

  if (view.status === "loading") {
    return <LoadingSkeleton label={m.view.loading} />;
  }

  if (view.status === "login-required") {
    return (
      <EmptyState
        title={m.view.loginTitle}
        description={m.view.loginDescription}
        action={
          <Link href="/login?next=%2Ffavorites" className="button button-dark">
            {m.view.loginButton}
          </Link>
        }
      />
    );
  }

  if (view.status === "forbidden") {
    return (
      <EmptyState
        title={m.view.forbiddenTitle}
        description={m.view.forbiddenDescription}
      />
    );
  }

  if (view.status === "error") {
    return <ErrorState message={view.message} onRetry={() => window.location.reload()} />;
  }

  if (view.items.length === 0) {
    return (
      <EmptyState
        title={m.view.emptyTitle}
        description={m.view.emptyDescription}
        action={
          <Link href="/companies" className="button button-dark">
            {m.view.emptyButton}
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
                    <dt>{m.view.region}</dt>
                    <dd>{item.region ?? m.view.noInfo}</dd>
                  </div>
                  <div>
                    <dt>{m.view.industry}</dt>
                    <dd>{item.industry ?? m.view.noInfo}</dd>
                  </div>
                  <div>
                    <dt>{m.view.addedAt}</dt>
                    <dd>{formatDate(item.created_at, locale)}</dd>
                  </div>
                </dl>
              </div>
            </div>
            <Link href={`/companies/${encodeURIComponent(item.company_id)}`} className="button button-outline">
              {m.view.details}
            </Link>
            <button
              type="button"
              className="button button-dark"
              disabled={removingId === item.company_id}
              onClick={() => void handleRemove(item.company_id)}
            >
              {removingId === item.company_id ? m.button.pending : m.button.remove}
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
