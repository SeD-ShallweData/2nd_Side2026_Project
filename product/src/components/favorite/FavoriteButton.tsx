"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { FavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { performFavoriteToggle } from "@/components/favorite/favoriteAuth";
import {
  describeFavoriteError,
  favoriteErrorRequiresLogin,
  localizeFavoriteReason,
} from "@/components/favorite/favoriteErrorMessage";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { favoriteMessages } from "@/i18n/messages/favorite";

interface FavoriteButtonProps {
  companyId: string;
  companyName: string;
  initialIsFavorite: boolean;
  /** 세션 조회 결과를 바탕으로 부모가 한 번만 계산해 내려주는 값. 오래됐을 수 있어
   *  eligible이 아니면 클릭 시점에 한 번 더 재확인한다(performFavoriteToggle). */
  eligibility: FavoriteEligibility;
  className?: string;
  onChange?: (companyId: string, isFavorite: boolean) => void;
}

export function FavoriteButton({
  companyId,
  companyName,
  initialIsFavorite,
  eligibility,
  className,
  onChange,
}: FavoriteButtonProps) {
  const pathname = usePathname();
  const m = useMessages(favoriteMessages);
  const [isFavorite, setIsFavorite] = useState(initialIsFavorite);
  // 부모는 즐겨찾기 목록을 비동기로 불러와 initialIsFavorite 를 나중에 true 로 바꾼다.
  // useState 초기값은 처음 한 번만 쓰이므로, 값이 바뀌면 렌더 중에 따라간다.
  const [syncedInitial, setSyncedInitial] = useState(initialIsFavorite);
  if (initialIsFavorite !== syncedInitial) {
    setSyncedInitial(initialIsFavorite);
    setIsFavorite(initialIsFavorite);
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requiresLogin: boolean } | null>(null);

  async function handleClick() {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await performFavoriteToggle(companyId, isFavorite, eligibility);
      if (result.status === "blocked") {
        setError({ ...result.reason, message: localizeFavoriteReason(result.reason.message, m.errors) });
        return;
      }
      setIsFavorite(result.isFavorite);
      onChange?.(companyId, result.isFavorite);
    } catch (caught) {
      setError({
        message: describeFavoriteError(caught, m.errors),
        requiresLogin: favoriteErrorRequiresLogin(caught),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={["button", isFavorite ? "button-outline" : "button-dark", className].filter(Boolean).join(" ")}
        disabled={pending}
        aria-pressed={isFavorite}
        aria-label={format(m.button.aria, { name: companyName, action: isFavorite ? m.button.remove : m.button.add })}
        onClick={() => void handleClick()}
      >
        {pending ? m.button.pending : isFavorite ? m.button.remove : m.button.add}
      </button>
      {error ? (
        <p className="field-error" role="alert">
          {error.message}
          {error.requiresLogin ? (
            <>
              {" "}
              <Link href={`/login?next=${encodeURIComponent(pathname)}`}>{m.button.login}</Link>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
