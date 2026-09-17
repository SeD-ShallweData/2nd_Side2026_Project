"use client";

import { useEffect, useState } from "react";

import { getSession } from "@/services/authClient";

/*
 * 데이터 출처 배너는 운영자에게만 보인다.
 *
 * "PostgreSQL 명부를 읽기 전용으로 조회한다" 같은 문구는 우리가 데이터를
 * 어떻게 다루는지 스스로 점검하려고 띄운 것이지 방문자에게 필요한 정보가
 * 아니다. 시연 부스에서 심사위원이 먼저 보게 되는 자리이기도 해서, 플랫폼
 * 담당자(auth_role='admin') 로 로그인했을 때만 노출한다.
 */
export function DataModeNotice({
  dataMode,
  realMessage,
  mockMessage,
}: {
  dataMode: "real" | "mock";
  realMessage: string;
  mockMessage: string;
}) {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((session) => {
        if (ignore) return;
        setIsAdmin(session.authenticated && session.user.role === "admin");
      })
      .catch(() => {
        // 세션을 못 읽으면 로그인하지 않은 것과 같게 본다 — 배너를 감춘다.
        if (!ignore) setIsAdmin(false);
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  if (!isAdmin) return null;

  return (
    <div className={`mode-banner mode-banner-${dataMode}`} role="status">
      <span>{dataMode === "real" ? "READ ONLY DB" : "DEMO"}</span>
      {dataMode === "real" ? realMessage : mockMessage}
    </div>
  );
}
