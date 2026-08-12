import { CommunityPreview, ConsultPreviewSection, ContractPreviewSection, FeatureSection, FinalCta, RiskPreviewSection } from "@/components/landing/FeatureSection";
import { LandingHero } from "@/components/landing/LandingHero";

export default function HomePage() {
  return (
    <>
      <LandingHero />
      <FeatureSection />
      <RiskPreviewSection />
      <ContractPreviewSection />
      <CommunityPreview />
      <ConsultPreviewSection />
      <FinalCta />
    </>
  );
}
