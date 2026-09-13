import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "회원가입" };

export default function SignupPage() {
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">Co끼리</span>
          <h1>회원가입</h1>
          <p>이름, 이메일, 비밀번호로 가입하면 바로 로그인 상태가 됩니다.</p>
        </div>
        <SignupForm />
      </div>
    </div>
  );
}
