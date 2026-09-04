"use client";

import { useMemo, useState } from "react";
import type { CapabilityEntry } from "@/data/capabilityIndex";

// No "g" flag: isHanScript() is a stateless boolean check called many times
// per render (once per alias, once per alias bigram); a global regex's
// .test() carries lastIndex across calls and silently flips results
// depending on call order — this produced a real false positive (a "大小写"
// query incorrectly matching an entry through an alias) during testing.
const hanScriptPattern = /[㐀-鿿]/;

function isHanScript(value: string): boolean {
  return hanScriptPattern.test(value);
}

function compact(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

// Bigram overlap over a whole title/description is too permissive: a short
// query like "表大小" (table size) shares its "大小" bigram with completely
// unrelated titles like "数据类型大小写" (data type CASE) — same substring,
// different meaning. Curated aliases don't have this problem (they're
// short, deliberately distinctive phrases), so they alone use bigram
// coverage — mirroring the same Han/Latin split used by the GitHub bot
// (.github/scripts/suggest-existing-capability.mjs) for the same reason.
// Title/description matching instead requires an exact (but
// whitespace/case-insensitive) substring in either direction, so it never
// fires on a shared fragment alone.
function aliasCoverage(query: string, alias: string): number {
  const compactAlias = compact(alias);
  if (compactAlias.length === 0) return 0;
  const compactQuery = compact(query);

  if (!isHanScript(compactAlias)) {
    return compactQuery.includes(compactAlias) ? 1 : 0;
  }

  const aliasGrams: string[] = [];
  for (let i = 0; i < compactAlias.length - 1; i += 1) {
    const gram = compactAlias.slice(i, i + 2);
    if (isHanScript(gram)) aliasGrams.push(gram);
  }
  if (aliasGrams.length === 0) return 0;
  let matched = 0;
  for (const gram of aliasGrams) if (compactQuery.includes(gram)) matched += 1;
  return matched / aliasGrams.length;
}

function substringScore(query: string, text: string): number {
  const compactQuery = compact(query);
  const compactText = compact(text);
  if (compactQuery.length === 0 || compactText.length === 0) return 0;
  if (compactText.includes(compactQuery) || compactQuery.includes(compactText)) return 1;
  return 0;
}

const kindLabel: Record<string, { cn: string; en: string }> = {
  setting: { cn: "设置项", en: "Setting" },
  toolbar: { cn: "工具栏", en: "Toolbar" },
  shortcut: { cn: "快捷键", en: "Shortcut" },
  database: { cn: "数据库", en: "Database" },
};

const copy = {
  cn: {
    placeholder: "搜索功能，例如“表大小”“milvus”“执行 SQL”…",
    empty: "没有找到匹配的能力，换个说法试试？也可以在 GitHub 上提问。",
    since: (v: string) => `自 ${v} 起支持`,
    location: (p: string) => `位置：${p.replace("settings#", "设置 → ")}`,
    shortcutHint: (k: string) => `默认快捷键：${k}`,
    count: (n: number) => `共 ${n} 项能力`,
  },
  en: {
    placeholder: 'Search for a feature, e.g. "table size", "milvus", "execute sql"…',
    empty: "No matching capability found — try a different phrase, or ask on GitHub.",
    since: (v: string) => `Since ${v}`,
    location: (p: string) => `Location: ${p.replace("settings#", "Settings → ")}`,
    shortcutHint: (k: string) => `Default shortcut: ${k}`,
    count: (n: number) => `${n} capabilities`,
  },
};

export function CapabilityExplorer({ entries, lang }: { entries: CapabilityEntry[]; lang: "en" | "cn" }) {
  const [query, setQuery] = useState("");
  const t = copy[lang];

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return entries;
    return entries
      .map((entry) => {
        const aliasScore = Math.max(0, ...entry.aliases.map((alias) => aliasCoverage(trimmed, alias)).filter((coverage) => coverage >= 0.6));
        const titleScore = substringScore(trimmed, `${entry.title.cn} ${entry.title.en}`);
        const descScore = substringScore(trimmed, `${entry.description.cn} ${entry.description.en}`) * 0.8;
        return { entry, score: Math.max(aliasScore, titleScore, descScore) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.entry);
  }, [entries, query]);

  return (
    <div>
      <div className="relative max-w-[640px] mx-auto">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.placeholder}
          className="w-full rounded-[10px] border border-[color-mix(in_srgb,var(--color-landing-ink)_14%,transparent)] bg-[color-mix(in_srgb,var(--color-landing-ink)_4%,transparent)] px-4 py-3 text-[15px] text-landing-ink placeholder:text-landing-muted outline-none focus:border-landing-blue"
          data-testid="capability-search-input"
        />
      </div>
      <p className="mt-3 text-center text-xs text-landing-muted">{t.count(results.length)}</p>

      <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="capability-results">
        {results.map((entry) => {
          const title = lang === "cn" ? entry.title.cn : entry.title.en;
          const description = lang === "cn" ? entry.description.cn : entry.description.en;
          const kind = kindLabel[entry.kind]?.[lang] ?? entry.kind;
          return (
            <li key={entry.id} className="landing-glass-card rounded-[10px] p-4" data-capability-id={entry.id}>
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[15px] font-[650] text-landing-ink">{title}</strong>
                <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--color-landing-ink)_16%,transparent)] px-2 py-0.5 text-[11px] text-landing-muted">
                  {kind}
                </span>
              </div>
              {description ? <p className="mt-1.5 text-[13px] leading-[1.6] text-landing-muted">{description}</p> : null}
              <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-landing-muted">
                {entry.settingsPath ? <span>{t.location(entry.settingsPath)}</span> : null}
                {entry.defaultShortcut ? <span>{t.shortcutHint(entry.defaultShortcut)}</span> : null}
                {entry.sinceVersion ? <span>{t.since(entry.sinceVersion)}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>

      {results.length === 0 ? <p className="mt-10 text-center text-sm text-landing-muted">{t.empty}</p> : null}
    </div>
  );
}
