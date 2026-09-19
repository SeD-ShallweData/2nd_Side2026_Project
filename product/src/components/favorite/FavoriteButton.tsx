"use client";

import Link from "next/link";
import { useState } from "react";
import type { FavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { describeFavoriteError, favoriteErrorRequiresLogin } from "@/components/favorite/favoriteErrorMessage";
import { addFavorite, removeFavorite } from "@/services/favoriteClient";

interface FavoriteButtonProps {
  companyId: string;
  companyName: string;
  initialIsFavorite: boolean;
  /** 세션 조회 결과를 바탕으로 부모가 한 번만 계산해 내려주는 값. */
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
  const [isFavorite, setIsFavorite] = useState(initialIsFavorite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requiresLogin: boolean } | null>(null);

  async function handleClick() {
    if (pending) return;
    setError(null);

    if (!eligibility.eligible) {
      if (eligibility.reason) setError(eligibility.reason);
      return;
    }

    setPending(true);
    try {
      if (isFavorite) {
        await removeFavorite(companyId);
        setIsFavorite(false);
        onChange?.(companyId, false);
      } else {
        await addFavorite(companyId);
        setIsFavorite(true);
        onChange?.(companyId, true);
      }
    } catch (caught) {
      setError({
        message: describeFavoriteError(caught),
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
        aria-label={`${companyName} ${isFavorite ? "관심 해제" : "관심 추가"}`}
        onClick={() => void handleClick()}
      >
        {pending ? "처리 중" : isFavorite ? "관심 해제" : "관심 추가"}
      </button>
      {error ? (
        <p className="field-error" role="alert">
          {error.message}
          {error.requiresLogin ? (
            <>
              {" "}
              <Link href="/login">로그인하기</Link>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
