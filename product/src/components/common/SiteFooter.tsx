import { SiteFooterView } from "@/components/common/SiteFooterView";
import { getDataMode } from "@/config/dataMode";

export function SiteFooter() {
  const dataMode = getDataMode();
  return <SiteFooterView dataMode={dataMode} />;
}
