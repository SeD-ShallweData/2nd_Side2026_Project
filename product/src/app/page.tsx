import { CommunityPreview, ConsultPreviewSection, ContractPreviewSection, FeatureSection, FinalCta, RiskPreviewSection } from "@/components/landing/FeatureSection";
import { LandingHero } from "@/components/landing/LandingHero";
import { landingMessages } from "@/i18n/messages/landing";
import { getMessages } from "@/i18n/server";

export default async function HomePage() {
  // 랜딩 부품은 서버 컴포넌트로 두고, 현재 언어 사전을 여기서 한 번 골라 넘긴다.
  const m = await getMessages(landingMessages);
  return (
    <>
      <LandingHero m={m} />
      <FeatureSection m={m} />
      <RiskPreviewSection m={m} />
      <ContractPreviewSection m={m} />
      <CommunityPreview m={m} />
      <ConsultPreviewSection m={m} />
      <FinalCta m={m} />
    </>
  );
}
