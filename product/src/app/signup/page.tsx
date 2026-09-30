import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";
import { authMessages } from "@/i18n/messages/auth";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(authMessages);
  return { title: m.signup.metaTitle };
}

export default async function SignupPage() {
  const messages = await getMessages(authMessages);
  const m = messages.signup;
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">{messages.brand}</span>
          <h1>{m.heading}</h1>
          <p>{m.intro}</p>
        </div>
        <SignupForm />
      </div>
    </div>
  );
}
