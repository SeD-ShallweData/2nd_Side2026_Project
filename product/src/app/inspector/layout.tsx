import type { ReactNode } from "react";

import { requireInspectorPage } from "@/server/auth/pageGuards";

export default async function InspectorLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // 배치 현황처럼 운영에 속한 화면은 각 페이지에서 다시 admin 으로 좁힌다.
  // 레이아웃은 클라이언트 이동 때 다시 실행되지 않으므로, 각 페이지도 스스로 다시 검사한다.
  await requireInspectorPage();

  return children;
}
