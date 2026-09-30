"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { headerMessages } from "@/i18n/messages/header";

/*
 * 헤더 오른쪽의 이름 버튼. 누르면 즐겨찾기·계정 삭제(일반 사용자), 신고 관리(관리자),
 * 로그아웃(모든 역할)이 펼쳐진다. 헤더에 버튼을 늘어놓으면 언어 선택기와 가운데 메뉴가 겹치고,
 * 계정 삭제가 늘 눈앞에 있게 된다.
 */
export function AccountMenu({
  name,
  role,
  deleting,
  loggingOut,
  onDeleteAccount,
  onLogout,
}: {
  name: string;
  role: string;
  deleting: boolean;
  loggingOut: boolean;
  onDeleteAccount: () => void;
  onLogout: () => void;
}) {
  const m = useMessages(headerMessages);
  const pathname = usePathname();
  // 연 화면의 경로를 기억해, 다른 화면으로 옮겨 가면 저절로 닫힌 것으로 본다.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = format(m.userSuffix, { name });

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpenAt(null);
        return;
      }
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenAt(null);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-menu-toggle"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={format(m.accountMenuAria, { name: label })}
        onClick={() => setOpenAt(open ? null : pathname)}
      >
        <span className="account-menu-name">{label}</span>
        <span aria-hidden="true" className="account-menu-caret">▾</span>
      </button>
      {open ? (
        <div className="account-menu-panel" id={menuId} role="group" aria-label={format(m.accountMenuAria, { name: label })}>
          {role === "user" ? (
            <Link
              href="/favorites"
              className={pathname === "/favorites" ? "is-current" : undefined}
              aria-current={pathname === "/favorites" ? "page" : undefined}
              onClick={() => setOpenAt(null)}
            >
              {m.favorites}
            </Link>
          ) : null}
          {role === "admin" ? (
            <Link href="/admin" onClick={() => setOpenAt(null)}>{m.moderation}</Link>
          ) : null}
          {role === "user" ? (
            <button
              type="button"
              className="account-menu-danger"
              disabled={deleting || loggingOut}
              onClick={() => {
                setOpenAt(null);
                onDeleteAccount();
              }}
            >
              {deleting ? m.deleting : m.deleteAccount}
            </button>
          ) : null}
          <button type="button" disabled={deleting || loggingOut} onClick={onLogout}>
            {loggingOut ? m.loggingOut : m.logout}
          </button>
        </div>
      ) : null}
    </div>
  );
}
