import Link from "next/link";
import { cookies } from "next/headers";

import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export async function InspectorNav({ current }: { current: "dashboard" | "chat" | "batches" | "ml-dashboard" }) {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  const isOperator = canOperatePlatform(user?.role);

  return (
    <div className="inspector-nav-wrap">
      <div className="shell inspector-nav">
        <Link href="/inspector" className="inspector-identity">
          <span aria-hidden="true">DW</span>
          <div>
            <strong>Machine Learning Operations</strong>
            <small>임금체불 · 산업재해 예측 모델링 지원</small>
          </div>
        </Link>
        <nav aria-label="근로감독관 메뉴">
          <Link href="/inspector" aria-current={current === "dashboard" ? "page" : undefined}>
            사업장 대시보드
          </Link>
          <Link href="/inspector/chat" aria-current={current === "chat" ? "page" : undefined}>
            AI 점검 보조
          </Link>
          {/* 배치는 플랫폼 운영이다. 근로감독관에게는 보이지 않는다. */}
          {isOperator ? (
            <Link href="/inspector/batches" aria-current={current === "batches" ? "page" : undefined}>
              배치 현황
            </Link>
          ) : null}
          <Link href="/inspector/ml-dashboard" aria-current={current === "ml-dashboard" ? "page" : undefined}>
            ML 대시보드
          </Link>
        </nav>
        <span className="inspector-private-badge">
          {isOperator ? "운영 관리자" : "근로감독관 · 읽기 전용"}
        </span>
      </div>
    </div>
  );
}
