import type { Metadata } from "next";
import { InspectorDashboard } from "@/components/inspector/InspectorDashboard";
import { InspectorNav } from "@/components/inspector/InspectorNav";

export const metadata: Metadata = { title: "근로감독관 대시보드" };

export default function InspectorPage() {
  return (
    <div className="inspector-page">
      <InspectorNav current="dashboard" />
      <InspectorDashboard />
    </div>
  );
}
