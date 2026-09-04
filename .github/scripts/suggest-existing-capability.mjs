#!/usr/bin/env node
// Uses an LLM to judge whether a newly opened issue's request is already
// covered by an existing dbx setting/shortcut/database, using
// docs/data/capabilityIndex.json + capabilityAliases.json as a small,
// in-context knowledge base (no vector store — 300 compact records fit
// comfortably in a single call).
//
// Why an LLM instead of string matching: an earlier bigram/alias-coverage
// version worked (0 false positives on 143 real negative issues) but only
// by requiring an exact-ish phrase match, which meant a differently worded
// request (or one that only partially overlaps an existing capability)
// silently fell through. That's a real ceiling for a knowledge base meant
// to answer "is this already covered" in natural language. See the plan
// doc for the cost/volume math backing this design (~58 issues/day,
// reusing the same secrets.DEEPSEEK_API_KEY already paid for by
// sync-changelog.mjs).
//
// Anti-hallucination rule: the model is only asked to (a) decide whether a
// match exists and (b) explain *why* in prose. Every factual detail in the
// posted comment (sinceVersion, settingsPath) is rendered by this script
// from docs/data/capabilityIndex.json, never taken from the model's own
// text — and any capabilityId the model returns that isn't actually in the
// index is dropped before rendering.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseIssueSections, stripIssuePrefix, stripMarkdown } from "./suggest-similar-issues.mjs";

const API_VERSION = "2022-11-28";
const COMMENT_MARKER = "<!-- dbx-capability-hint -->";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ISSUE_BODY_LENGTH = 4000;
const LOW_CONFIDENCE = "low";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");

function loadCapabilityIndex() {
  const indexPath = path.join(repositoryRoot, "docs/data/capabilityIndex.json");
  const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  return raw.entries;
}

// One line per capability: id | title | category | settings path | since
// version | default shortcut | known aliases. Kept intentionally compact
// (no descriptions) to keep the fixed knowledge-base prefix small — this
// text is identical across calls, so a provider with prompt caching (like
// DeepSeek) bills repeat calls at its cached-input rate.
export function renderKnowledgeBase(entries) {
  return entries
    .map((entry) => {
      const parts = [entry.id, entry.title.cn, entry.category];
      if (entry.settingsPath) parts.push(entry.settingsPath.replace("settings#", "设置→"));
      if (entry.sinceVersion) parts.push(entry.sinceVersion);
      if (entry.defaultShortcut) parts.push(entry.defaultShortcut);
      if (entry.aliases?.length) parts.push(`别名:${entry.aliases.join("/")}`);
      return parts.join(" | ");
    })
    .join("\n");
}

function issueSearchableText(issue) {
  const title = stripIssuePrefix(issue.title);
  const sections = parseIssueSections(issue.body).map(({ content }) => content).join("\n");
  return `${title}\n${stripMarkdown(sections)}`.slice(0, MAX_ISSUE_BODY_LENGTH);
}

function hasChinese(value) {
  return /\p{Script=Han}/u.test(String(value || ""));
}

const SYSTEM_PROMPT_HEADER = `You triage new GitHub issues for the dbx database client. You are given a compact knowledge base of dbx's existing settings, shortcuts and supported databases (one per line: id | title | category | settings path | since version | shortcut | known aliases).

Decide whether the issue's request is ALREADY covered by one or more of these capabilities.

Rules:
- Only use capabilities from the list below — never invent an id that isn't listed.
- If you are not reasonably confident, report no match. A missed match is far less harmful than a wrong one.
- A capability that is only tangentially related, or that would need to be extended/changed to satisfy the request, is NOT a match — only report capabilities that already do what the issue asks for as they exist today.
- Write "explanation" in the same language as the issue (Chinese or English), addressed to the issue author, explaining briefly why the capability already covers their request. Do not restate the exact setting path or version number yourself — the caller renders those from data.
- Respond with JSON only, matching this schema:
  {"matched": boolean, "capabilityIds": string[], "confidence": "high"|"medium"|"low", "explanation": string}

Knowledge base:
`;

export function buildPrompt(issue, entries) {
  return {
    system: SYSTEM_PROMPT_HEADER + renderKnowledgeBase(entries),
    user: issueSearchableText(issue),
  };
}

async function callDeepSeek({ system, user }, { apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    console.warn("DEEPSEEK_API_KEY not set, skipping capability judgment");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`DeepSeek API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn("DeepSeek response was not valid JSON, skipping");
      return null;
    }
    if (typeof parsed.matched !== "boolean" || !Array.isArray(parsed.capabilityIds)) {
      console.warn("DeepSeek response did not match the expected schema, skipping");
      return null;
    }
    return parsed;
  } catch (error) {
    // Best-effort: a triage comment is a nice-to-have, never worth failing
    // the issue-opened workflow over a timeout or transient network error.
    console.warn(`DeepSeek call failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveMatchedEntries(judgment, entries) {
  if (!judgment || judgment.matched !== true || judgment.confidence === LOW_CONFIDENCE) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // Drop any id the model invented that isn't actually in the knowledge
  // base — this is the hallucination backstop, not just a formality.
  return judgment.capabilityIds.map((id) => byId.get(id)).filter(Boolean);
}

export function formatComment(matchedEntries, explanation, locale) {
  const lines = matchedEntries.map((entry) => {
    const title = locale === "cn" ? entry.title.cn : entry.title.en;
    const version = entry.sinceVersion ? ` (${locale === "cn" ? "自 " + entry.sinceVersion + " 起支持" : "since " + entry.sinceVersion})` : "";
    const location = entry.settingsPath
      ? locale === "cn"
        ? `，位置：${entry.settingsPath.replace("settings#", "设置 → ")}`
        : `, location: ${entry.settingsPath.replace("settings#", "Settings → ")}`
      : "";
    return `- **${title}**${version}${location}`;
  });
  const explanationText = (explanation || "").trim();

  if (locale === "cn") {
    return [
      COMMENT_MARKER,
      "以下能力可能已经覆盖了这个需求（由 AI 自动判断，仅供参考，不代表结论一定准确）：",
      "",
      lines.join("\n"),
      "",
      explanationText,
      "",
      "如果不满足需求，请补充说明差异；如果已解决，可以关闭本 issue。",
    ].filter(Boolean).join("\n");
  }
  return [
    COMMENT_MARKER,
    "The following capabilities may already cover this request (AI-generated best-effort match, not a guaranteed conclusion):",
    "",
    lines.join("\n"),
    "",
    explanationText,
    "",
    "If this doesn't meet your need, please describe the gap; if it does, feel free to close this issue.",
  ].filter(Boolean).join("\n");
}

function loadIssue() {
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).issue || {};
  }
  return {
    number: process.env.ISSUE_NUMBER,
    title: process.env.ISSUE_TITLE || "",
    body: process.env.ISSUE_BODY || "",
  };
}

export class GitHubClient {
  constructor({ token, repository, apiBase = "https://api.github.com" }) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    if (!repository) throw new Error("GITHUB_REPOSITORY is required");
    this.token = token;
    this.repository = repository;
    this.apiBase = apiBase.replace(/\/$/u, "");
  }

  async request(method, apiPath, body) {
    const response = await fetch(`${this.apiBase}${apiPath}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${method} ${apiPath} failed: ${response.status} ${payload?.message || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async hasExistingComment(issueNumber) {
    const comments = await this.request("GET", `/repos/${this.repository}/issues/${issueNumber}/comments?per_page=100`);
    return comments.some((comment) => String(comment.body || "").includes(COMMENT_MARKER));
  }

  async comment(issueNumber, body) {
    return this.request("POST", `/repos/${this.repository}/issues/${issueNumber}/comments`, { body });
  }
}

export async function run({
  issue = loadIssue(),
  client,
  entries = loadCapabilityIndex(),
  deepseekApiKey = process.env.DEEPSEEK_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (issue.pull_request) {
    console.log("Skipping pull request event");
    return [];
  }
  if (!issue.number) throw new Error("Issue number is required");

  const github = client || new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiBase: process.env.GITHUB_API_URL,
  });
  if (await github.hasExistingComment(issue.number)) {
    console.log("Capability hint comment already exists");
    return [];
  }

  const prompt = buildPrompt(issue, entries);
  const judgment = await callDeepSeek(prompt, { apiKey: deepseekApiKey, fetchImpl });
  const matchedEntries = resolveMatchedEntries(judgment, entries);
  if (matchedEntries.length === 0) {
    console.log("No confident capability match for this issue");
    return [];
  }

  const locale = hasChinese(`${issue.title}\n${issue.body}`) ? "cn" : "en";
  const comment = formatComment(matchedEntries, judgment.explanation, locale);

  if (process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true") {
    console.log(comment);
    return matchedEntries;
  }

  await github.comment(issue.number, comment);
  console.log(`Commented ${matchedEntries.length} capability hint(s) on #${issue.number}`);
  return matchedEntries;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run();
}
