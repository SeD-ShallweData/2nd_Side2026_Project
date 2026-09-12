import Link from "next/link";

export default function InspectorForbidden() {
  return (
    <main className="state-box" aria-labelledby="inspector-forbidden-title">
      <h1 id="inspector-forbidden-title">접근 권한이 없습니다</h1>
      <p>근로감독관 계정으로 로그인해 주세요.</p>
      <Link href="/login">로그인으로 이동</Link>
    </main>
  );
}
