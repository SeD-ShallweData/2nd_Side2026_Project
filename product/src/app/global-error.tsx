"use client";

import { errorReferenceCodeOf } from "@/utils/errorReference";

/*
 * 루트 레이아웃 자체가 실패했을 때의 마지막 대체 화면.
 *
 * 루트 레이아웃을 대신해 문서 전체(<html>·<body>)를 그리므로 언어 공급자와 전역 CSS 가 없다.
 * 그래서 사전 대신 한국어 고정 문구를, 클래스 대신 인라인 스타일을 쓴다. 의존성을 줄여야
 * 레이아웃을 망가뜨린 원인에 여기까지 끌려 들어가지 않는다.
 * 오류 문구와 스택은 보여 주지 않고 digest 앞부분만 문의 코드로 보여 준다.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const reference = errorReferenceCodeOf(error);
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          background: "#ffffff",
          color: "#081f3a",
          fontFamily: 'Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif',
          lineHeight: 1.6,
          wordBreak: "keep-all",
        }}
      >
        <title>일시적인 오류 | Co끼리</title>
        <main style={{ maxWidth: 560, margin: "96px auto", padding: "0 20px", textAlign: "center" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: "1.4rem" }}>일시적인 오류가 발생했습니다</h1>
          <p style={{ margin: "0 0 12px", color: "#3a6ba3" }}>
            화면을 불러오는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.
          </p>
          {reference ? (
            <p style={{ margin: "0 0 16px", color: "#3a6ba3" }}>문의 코드 {reference}</p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              border: 0,
              borderRadius: 999,
              background: "#081f3a",
              color: "#ffffff",
              padding: "10px 20px",
              font: "inherit",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            다시 시도
          </button>
        </main>
      </body>
    </html>
  );
}
