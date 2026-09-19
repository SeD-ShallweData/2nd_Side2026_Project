import type { Metadata } from "next";
import { WorksiteTipPage } from "@/components/worksite/WorksiteTipPage";

export const metadata: Metadata = { title: "현장 신고" };

export default function WorksiteTipsPage() {
  return <WorksiteTipPage />;
}
