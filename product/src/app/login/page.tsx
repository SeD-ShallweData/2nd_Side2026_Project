import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "로그인" };

export default function LoginPage() {
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">Co끼리</span>
          <h1>로그인</h1>
          <p>이메일과 비밀번호로 로그인해 주세요.</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
