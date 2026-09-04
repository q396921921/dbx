// Generates docs/data/capabilityIndex.json — a machine-readable index of dbx
// settings, shortcuts, toolbar toggles and supported databases, so the
// website and the GitHub bot can both answer "does dbx already support X".
//
// Run with: pnpm build:capability-index
// Check (CI):  pnpm check:capability-index
//
// Must be run with tsx (not plain node) because it imports the app's TS
// source directly (path aliases, nested i18n modules with
// withEnglishFallback()). Re-implementing these structures with regex would
// silently drop entries — an earlier regex prototype found 138 settings
// definitions when the real number is 150.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { SETTINGS_SEARCH_DEFINITIONS } from "../apps/desktop/src/lib/settings/settingsSearch";
import { SHORTCUT_DEFINITIONS } from "../apps/desktop/src/lib/editor/shortcutRegistry";
import zhCN from "../apps/desktop/src/i18n/locales/zh-CN";
import en from "../apps/desktop/src/i18n/locales/en";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const connectionTypeDirectory = join(root, "plugins", "connection-types");
const aliasesPath = join(root, "docs", "data", "capabilityAliases.json");
const outputPath = join(root, "docs", "data", "capabilityIndex.json");
const checkOnly = process.argv.includes("--check");

type LocalizedText = { cn: string; en: string };

interface CapabilityEntry {
  id: string;
  kind: "setting" | "shortcut" | "database";
  category: string;
  title: LocalizedText;
  description: LocalizedText;
  settingsPath?: string;
  defaultShortcut?: string;
  sinceVersion: string;
  aliases: string[];
}

function pick(bundle: unknown, key: string): string {
  let current: unknown = bundle;
  for (const part of key.split(".")) {
    if (current == null || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : "";
}

// --- sinceVersion: reverse-engineered from git history, with an incremental
// cache so CI (which only has fetch-depth: 1) never needs to run this — only
// a local full regeneration does. ---
let previousIndex: CapabilityEntry[] = [];
if (existsSync(outputPath)) {
  try {
    previousIndex = (JSON.parse(readFileSync(outputPath, "utf8")).entries ?? []) as CapabilityEntry[];
  } catch {
    previousIndex = [];
  }
}
const previousVersionById = new Map(previousIndex.map((entry) => [entry.id, entry.sinceVersion]));

function sinceVersionForI18nKey(id: string, i18nKey: string): string {
  const cached = previousVersionById.get(id);
  if (cached) return cached;
  if (!i18nKey) return "";
  const leaf = i18nKey.split(".").pop()!;
  try {
    const commits = execFileSync(
      "git",
      ["log", "--format=%H", "-S", leaf, "--reverse", "--", "apps/desktop/src/i18n/locales/en.ts"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const firstCommit = commits.split("\n")[0];
    if (!firstCommit) return "";
    return execFileSync("git", ["describe", "--contains", "--match", "v[0-9]*", firstCommit], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/[~^].*/, "");
  } catch {
    return "";
  }
}

// --- aliases: hand-curated, mined from historical "already supported" issue
// replies. Not required to exist yet (populated in a later phase). ---
let aliasesById: Record<string, string[]> = {};
if (existsSync(aliasesPath)) {
  aliasesById = JSON.parse(readFileSync(aliasesPath, "utf8"));
}

// --- settings + toolbar toggles ---
// SETTINGS_SEARCH_DEFINITIONS already spreads in
// createToolbarVisibilitySettingsSearchDefinitions() internally (see
// settingsSearch.ts) — appending it again here would duplicate the 12
// toolbar-visibility ids.
const settingEntries: CapabilityEntry[] = SETTINGS_SEARCH_DEFINITIONS.map((definition) => {
  const titleKey = definition.titleKey;
  const title: LocalizedText = titleKey
    ? { cn: pick(zhCN, titleKey), en: pick(en, titleKey) }
    : { cn: definition.title ?? "", en: definition.title ?? "" };
  const description: LocalizedText = definition.descriptionKey
    ? { cn: pick(zhCN, definition.descriptionKey), en: pick(en, definition.descriptionKey) }
    : { cn: "", en: "" };
  return {
    id: definition.id,
    kind: "setting",
    category: definition.category,
    title,
    description,
    settingsPath: `settings#${definition.targetId ?? definition.category}`,
    sinceVersion: sinceVersionForI18nKey(definition.id, titleKey ?? ""),
    aliases: aliasesById[definition.id] ?? [],
  };
});

// --- shortcuts ---
const shortcutEntries: CapabilityEntry[] = SHORTCUT_DEFINITIONS.map((shortcut) => {
  const id = `shortcut-${shortcut.id}`;
  return {
    id,
    kind: "shortcut",
    category: shortcut.scope,
    title: { cn: pick(zhCN, shortcut.labelKey), en: pick(en, shortcut.labelKey) },
    description: { cn: "", en: "" },
    settingsPath: "settings#shortcuts",
    defaultShortcut: shortcut.defaultShortcut,
    sinceVersion: sinceVersionForI18nKey(id, shortcut.labelKey),
    aliases: aliasesById[id] ?? [],
  };
});

// --- databases (from plugins/connection-types/*.yaml) ---
const databaseEntries: CapabilityEntry[] = readdirSync(connectionTypeDirectory)
  .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
  .sort()
  .map((file) => {
    const descriptor = parseYaml(readFileSync(join(connectionTypeDirectory, file), "utf8")) as {
      dbType: string;
      label: string;
    };
    const id = `database-${descriptor.dbType}`;
    return {
      id,
      kind: "database",
      category: "database",
      title: { cn: descriptor.label, en: descriptor.label },
      description: { cn: "", en: "" },
      sinceVersion: previousVersionById.get(id) ?? "",
      aliases: aliasesById[id] ?? [],
    };
  });

const entries = [...settingEntries, ...shortcutEntries, ...databaseEntries].sort((a, b) =>
  a.id.localeCompare(b.id),
);

const expected = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  const currentIds = new Set(
    (current ? (JSON.parse(current).entries as CapabilityEntry[]) : []).map((entry) => entry.id),
  );
  const missingIds = entries.filter((entry) => !currentIds.has(entry.id)).map((entry) => entry.id);
  const currentTitlesById = new Map(
    (current ? (JSON.parse(current).entries as CapabilityEntry[]) : []).map((entry) => [entry.id, entry.title.cn]),
  );
  const changedTitles = entries.filter(
    (entry) => currentTitlesById.has(entry.id) && currentTitlesById.get(entry.id) !== entry.title.cn,
  );
  if (missingIds.length > 0 || changedTitles.length > 0) {
    if (missingIds.length > 0) {
      console.error(`docs/data/capabilityIndex.json is missing ${missingIds.length} id(s): ${missingIds.slice(0, 10).join(", ")}${missingIds.length > 10 ? ", ..." : ""}`);
    }
    if (changedTitles.length > 0) {
      console.error(`docs/data/capabilityIndex.json has ${changedTitles.length} stale title(s): ${changedTitles.slice(0, 10).map((e) => e.id).join(", ")}`);
    }
    console.error("Run: pnpm build:capability-index");
    process.exit(1);
  }
  console.log(`Validated ${entries.length} capability index entries (id set + titles match).`);
  process.exit(0);
}

writeFileSync(outputPath, expected);
const withVersion = entries.filter((entry) => entry.sinceVersion).length;
console.log(
  `Generated ${entries.length} capability index entries ` +
    `(setting ${settingEntries.length}, shortcut ${shortcutEntries.length}, database ${databaseEntries.length}); ` +
    `${withVersion}/${entries.length} have a sinceVersion.`,
);
