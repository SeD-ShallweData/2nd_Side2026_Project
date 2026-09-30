import Link from "next/link";

/*
 * forbidden() 이 낸 403 화면. 관리자(/admin)·감독(/inspector) 화면이 함께 쓴다.
 *
 * 레이아웃에서 부른 forbidden() 은 같은 폴더의 forbidden.tsx 가 아니라 한 단계 위 경계가
 * 받는다. 그래서 전에는 /inspector 레이아웃에서 막히면 Next 기본 영문 화면이, 페이지에서
 * 막히면 감독관 전용 문구가 떠서 같은 403 이 두 모양이었다. 여기 한 곳에만 둔다.
 * 권한 화면은 한국어로만 운영하므로 문구도 한국어로 고정한다.
 */
export default function ForbiddenPage() {
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="state-card not-found-card">
          <span className="state-icon" aria-hidden="true">
            !
          </span>
          <h1>접근 권한이 없습니다</h1>
          <p>이 화면은 권한이 있는 관리자 또는 근로감독관 계정으로만 볼 수 있습니다. 로그인한 계정을 확인해 주세요.</p>
          <Link href="/login" className="button button-dark">
            로그인으로 이동
          </Link>
          <Link href="/">첫 화면으로 돌아가기</Link>
        </div>
      </div>
    </div>
  );
}
