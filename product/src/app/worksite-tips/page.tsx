import type { Metadata } from "next";
import { WorksiteTipPage } from "@/components/worksite/WorksiteTipPage";
import { worksiteMessages } from "@/i18n/messages/worksite";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(worksiteMessages);
  return { title: m.metaTitle };
}

export default function WorksiteTipsPage() {
  return <WorksiteTipPage />;
}
