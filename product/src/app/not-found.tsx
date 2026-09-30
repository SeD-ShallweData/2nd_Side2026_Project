import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { getMessages } from "@/i18n/server";

export default async function NotFoundPage() {
  const m = (await getMessages(commonMessages)).notFound;
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="state-card not-found-card">
          <span className="state-icon" aria-hidden="true">
            ?
          </span>
          <h1>{m.title}</h1>
          <p>{m.desc}</p>
          <Link href="/companies" className="button button-dark">
            {m.action}
          </Link>
        </div>
      </div>
    </div>
  );
}
