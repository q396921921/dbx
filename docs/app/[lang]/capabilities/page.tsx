import type { Metadata } from "next";
import Link from "next/link";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { RevealSection } from "@/components/landing/RevealSection";
import { CapabilityExplorer } from "@/components/landing/CapabilityExplorer";
import { capabilityIndex } from "@/data/capabilityIndex";
import { buildMetadata } from "@/lib/metadata";

const i18n = {
  en: {
    title: "Capability Index",
    desc: "DBX has grown to hundreds of settings, shortcuts and supported databases. Search here before assuming a feature doesn't exist.",
    ctaTitle: "Still can't find it?",
    ctaDesc: "Open a GitHub Discussion or issue — this index only covers what already exists, not what should be built next.",
    ctaLink: "Ask on GitHub",
  },
  cn: {
    title: "能力索引",
    desc: "DBX 的设置项、快捷键和支持的数据库已经有几百个。先在这里搜一下，再确定某个功能是不是真的没有。",
    ctaTitle: "还是没找到？",
    ctaDesc: "去 GitHub Discussions 或提 issue 问问——这份索引只覆盖已有的能力，不代表将来要不要做新功能。",
    ctaLink: "在 GitHub 上提问",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];

  return buildMetadata({
    title: t.title,
    description: t.desc,
    path: `/${l}/capabilities`,
    lang: l,
  });
}

export default async function CapabilitiesPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];

  return (
    <main className="min-h-screen bg-[#08080a] text-landing-ink">
      <LandingNav lang={l} />

      <section className="relative overflow-hidden pt-28 pb-6">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7 max-[760px]:px-[18px]">
          <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
          <p className="mt-3 text-landing-muted text-lg max-w-[640px]">{t.desc}</p>
        </div>
      </section>

      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-10 max-[760px]:px-[18px]">
        <CapabilityExplorer entries={capabilityIndex} lang={l} />
      </RevealSection>

      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-16 max-[760px]:px-[18px]">
        <div className="landing-glass-card rounded-[10px] p-8 text-center max-w-[640px] mx-auto">
          <h2 className="text-[21px] font-[720]">{t.ctaTitle}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.ctaDesc}</p>
          <Link href="https://github.com/t8y2/dbx/discussions" target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-5 mt-5 text-sm font-[650]">
            {t.ctaLink}
          </Link>
        </div>
      </RevealSection>

      <LandingFooter lang={l} />
    </main>
  );
}
