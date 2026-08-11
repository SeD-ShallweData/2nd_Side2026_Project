import { CommunityPreview, FeatureSection, FinalCta, HowItWorks } from "@/components/landing/FeatureSection";
import { LandingHero } from "@/components/landing/LandingHero";

export default function HomePage() {
  return (
    <>
      <LandingHero />
      <FeatureSection />
      <HowItWorks />
      <CommunityPreview />
      <FinalCta />
    </>
  );
}
