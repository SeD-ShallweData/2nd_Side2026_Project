import type { Metadata } from "next";
import { FavoritesView } from "@/components/favorite/FavoritesView";

export const metadata: Metadata = {
  title: "내 즐겨찾기",
};

export default function FavoritesPage() {
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">내 즐겨찾기</span>
          <h1>관심 사업장</h1>
          <p>저장해 둔 사업장을 한눈에 확인하고 상세 정보로 이동하세요.</p>
        </div>
        <FavoritesView />
      </div>
    </div>
  );
}
