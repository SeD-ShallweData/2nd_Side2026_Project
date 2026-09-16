import type { Metadata } from "next";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { MlDashboardPage } from "@/components/inspector/MlDashboardPage";

export const metadata: Metadata = { title: "ML 대시보드" };

export default function MlDashboardRoute() {
  return <div className="inspector-page"><InspectorNav current="ml-dashboard" /><MlDashboardPage /></div>;
}
