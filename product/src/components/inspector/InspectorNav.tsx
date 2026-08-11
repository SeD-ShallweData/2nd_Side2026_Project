import Link from "next/link";

export function InspectorNav({ current }: { current: "dashboard" | "chat" }) {
  return (
    <div className="inspector-nav-wrap">
      <div className="shell inspector-nav">
        <Link href="/inspector" className="inspector-identity">
          <span aria-hidden="true">DW</span>
          <div>
            <strong>DONWORRY INSPECTOR</strong>
            <small>근로감독 지원 프로토타입</small>
          </div>
        </Link>
        <nav aria-label="근로감독관 메뉴">
          <Link href="/inspector" aria-current={current === "dashboard" ? "page" : undefined}>
            사업장 대시보드
          </Link>
          <Link href="/inspector/chat" aria-current={current === "chat" ? "page" : undefined}>
            AI 점검 보조
          </Link>
        </nav>
        <span className="inspector-private-badge">내부 전용 · READ ONLY</span>
      </div>
    </div>
  );
}
