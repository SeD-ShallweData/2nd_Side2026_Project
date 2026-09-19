import Link from "next/link";
import { cookies } from "next/headers";

import { canOperatePlatform } from "@/server/auth/inspectorAccess";
import { SESSION_COOKIE_NAME } from "@/server/auth/sessionCookie";
import { getOptionalSessionUser } from "@/services/authService";

export async function InspectorNav({ current }: { current: "dashboard" | "chat" | "batches" | "ml-dashboard" | "prompts" }) {
  const cookieStore = await cookies();
  const user = await getOptionalSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null);
  const isOperator = canOperatePlatform(user?.role);

  return (
    <div className="inspector-nav-wrap">
      <div className="shell inspector-nav">
        <Link href="/inspector" className="inspector-identity">
          <span aria-hidden="true">DW</span>
          <div>
            {/* 운영 관리자에게는 프롬프트·모델 운영까지 이 화면의 소관임을 이름으로 밝힌다.
                근로감독관에게는 원래 이름(모델 상태 확인용)을 그대로 둔다. */}
            <strong>{isOperator ? "AI & Machine Learning Operations" : "Machine Learning Operations"}</strong>
            <small>
              {isOperator
                ? "LLM 프롬프트 엔지니어링 · 임금체불·산업재해 예측 모델링 지원"
                : "임금체불 · 산업재해 예측 모델링 지원"}
            </small>
          </div>
        </Link>
        <nav aria-label="근로감독관 메뉴">
          {/* LLM 프롬프트는 운영 관리자에게만 보이고, 메뉴 맨 앞에 선다. */}
          {isOperator ? (
            <Link href="/inspector/prompts" aria-current={current === "prompts" ? "page" : undefined}>
              LLM 프롬프트
            </Link>
          ) : null}
          {/* 'AI 점검 보조' 는 별도 탭을 없앤다. 사업장 대시보드에서 사업장을
              열면 'AI 점검 보조 열기' 로 그 페이지에 바로 간다 — 고아 페이지가
              아니다. 이름도 그 관계를 드러내게 바꾼다. */}
          <Link href="/inspector" aria-current={current === "dashboard" || current === "chat" ? "page" : undefined}>
            사업장 대시보드 및 Rag 점검
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
