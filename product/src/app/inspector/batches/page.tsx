import type { Metadata } from "next";
import { InspectorNav } from "@/components/inspector/InspectorNav";
import { BatchStatusPage } from "@/components/inspector/BatchStatusPage";

export const metadata: Metadata = { title: "배치 현황" };

export default function InspectorBatchesPage() {
  return (
    <div className="inspector-page">
      <InspectorNav current="batches" />
      <BatchStatusPage />
    </div>
  );
}
