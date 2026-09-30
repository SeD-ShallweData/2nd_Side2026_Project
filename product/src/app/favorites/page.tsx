import type { Metadata } from "next";
import { FavoritesView } from "@/components/favorite/FavoritesView";
import { favoriteMessages } from "@/i18n/messages/favorite";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(favoriteMessages);
  return { title: m.page.metaTitle };
}

export default async function FavoritesPage() {
  const m = await getMessages(favoriteMessages);
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">{m.page.eyebrow}</span>
          <h1>{m.page.title}</h1>
          <p>{m.page.intro}</p>
        </div>
        <FavoritesView />
      </div>
    </div>
  );
}
