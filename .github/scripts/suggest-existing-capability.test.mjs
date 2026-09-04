import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrompt,
  formatComment,
  GitHubClient,
  renderKnowledgeBase,
  resolveMatchedEntries,
  run,
} from "./suggest-existing-capability.mjs";

const objectInfoEntry = {
  id: "navigation-object-info",
  kind: "setting",
  category: "navigation",
  title: { cn: "侧边栏附加信息", en: "Sidebar supplementary info" },
  description: { cn: "选择在名称后显示注释、对象大小或不显示。", en: "Choose comments or object sizes after names." },
  settingsPath: "settings#navigation",
  sinceVersion: "v0.5.64",
  aliases: ["表大小", "表占用空间", "占用空间"],
};

const noAliasEntry = {
  id: "editor-font",
  kind: "setting",
  category: "editor",
  title: { cn: "字体", en: "Font" },
  description: { cn: "", en: "" },
  settingsPath: "settings#editor",
  sinceVersion: "v0.5.1",
  aliases: [],
};

const entries = [objectInfoEntry, noAliasEntry];

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function deepSeekPayload(content) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

function fakeGithubClient({ existingComment = false } = {}) {
  const posted = [];
  return {
    posted,
    async hasExistingComment() {
      return existingComment;
    },
    async comment(issueNumber, body) {
      posted.push({ issueNumber, body });
    },
  };
}

test("renderKnowledgeBase produces one compact line per entry, no descriptions", () => {
  const text = renderKnowledgeBase(entries);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^navigation-object-info \| 侧边栏附加信息 \| navigation \| 设置→navigation \| v0\.5\.64 \| 别名:表大小\/表占用空间\/占用空间$/);
  assert.doesNotMatch(text, /选择在名称后显示/, "descriptions should be omitted to keep the prefix compact");
});

test("buildPrompt puts the knowledge base in the system message and the issue text in the user message", () => {
  const prompt = buildPrompt({ title: "[Feature] 表大小", body: "希望能看到表大小" }, entries);
  assert.match(prompt.system, /navigation-object-info/);
  assert.match(prompt.system, /JSON only/);
  assert.match(prompt.user, /表大小/);
  assert.doesNotMatch(prompt.user, /navigation-object-info/, "the knowledge base belongs in the cacheable system prefix, not the user message");
});

test("resolveMatchedEntries drops hallucinated ids not present in the knowledge base", () => {
  const judgment = { matched: true, capabilityIds: ["navigation-object-info", "made-up-id"], confidence: "high" };
  const resolved = resolveMatchedEntries(judgment, entries);
  assert.deepEqual(resolved.map((e) => e.id), ["navigation-object-info"]);
});

test("resolveMatchedEntries returns nothing for matched=false, low confidence, or a null judgment", () => {
  assert.deepEqual(resolveMatchedEntries(null, entries), []);
  assert.deepEqual(resolveMatchedEntries({ matched: false, capabilityIds: ["navigation-object-info"], confidence: "high" }, entries), []);
  assert.deepEqual(resolveMatchedEntries({ matched: true, capabilityIds: ["navigation-object-info"], confidence: "low" }, entries), []);
});

test("formatComment never restates settingsPath/sinceVersion from model text, only from data", () => {
  const comment = formatComment([objectInfoEntry], "这就是你想要的功能，试试看吧", "cn");
  assert.match(comment, /<!-- dbx-capability-hint -->/);
  assert.match(comment, /侧边栏附加信息/);
  assert.match(comment, /v0\.5\.64/);
  assert.match(comment, /设置 → navigation/);
  assert.match(comment, /AI 自动判断/);
  assert.match(comment, /这就是你想要的功能，试试看吧/);
});

test("formatComment renders English for non-Chinese callers", () => {
  const comment = formatComment([objectInfoEntry], "This already covers it.", "en");
  assert.match(comment, /Sidebar supplementary info/);
  assert.match(comment, /since v0\.5\.64/);
  assert.match(comment, /Settings → navigation/);
});

test("run() posts a comment when the model confidently matches", async () => {
  const client = fakeGithubClient();
  const fetchImpl = async () => deepSeekPayload({
    matched: true,
    capabilityIds: ["navigation-object-info"],
    confidence: "high",
    explanation: "该设置已经支持按对象大小显示。",
  });
  const result = await run({
    issue: { number: 7452, title: "[Feature] 表大小显示", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "navigation-object-info");
  assert.equal(client.posted.length, 1);
  assert.match(client.posted[0].body, /该设置已经支持按对象大小显示/);
});

test("run() does not post when the model reports no match", async () => {
  const client = fakeGithubClient();
  const fetchImpl = async () => deepSeekPayload({ matched: false, capabilityIds: [], confidence: "high" });
  const result = await run({
    issue: { number: 1, title: "希望支持 Cassandra 数据库", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result, []);
  assert.equal(client.posted.length, 0);
});

test("run() does not post on a low-confidence match", async () => {
  const client = fakeGithubClient();
  const fetchImpl = async () => deepSeekPayload({ matched: true, capabilityIds: ["navigation-object-info"], confidence: "low" });
  const result = await run({
    issue: { number: 1, title: "有点像表大小但不确定", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result, []);
  assert.equal(client.posted.length, 0);
});

test("run() degrades silently on a DeepSeek API error", async () => {
  const client = fakeGithubClient();
  const fetchImpl = async () => jsonResponse({ error: "rate limited" }, 429);
  const result = await run({
    issue: { number: 1, title: "表大小", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result, []);
  assert.equal(client.posted.length, 0);
});

test("run() degrades silently on malformed JSON in the model response", async () => {
  const client = fakeGithubClient();
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: "not json at all" } }] });
  const result = await run({
    issue: { number: 1, title: "表大小", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result, []);
});

test("run() skips the LLM call entirely when no API key is configured", async () => {
  const client = fakeGithubClient();
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return deepSeekPayload({ matched: true, capabilityIds: ["navigation-object-info"], confidence: "high" });
  };
  const result = await run({
    issue: { number: 1, title: "表大小", body: "" },
    entries,
    client,
    deepseekApiKey: "",
    fetchImpl,
  });
  assert.deepEqual(result, []);
  assert.equal(fetchCalled, false);
});

test("run() is idempotent: skips the LLM call when a capability hint comment already exists", async () => {
  const client = fakeGithubClient({ existingComment: true });
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return deepSeekPayload({ matched: true, capabilityIds: ["navigation-object-info"], confidence: "high" });
  };
  const result = await run({
    issue: { number: 7452, title: "表大小", body: "" },
    entries,
    client,
    deepseekApiKey: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result, []);
  assert.equal(fetchCalled, false, "should not spend an API call once a hint is already posted");
});

test("run() returns early on pull_request events without touching GitHub or the model", async () => {
  let calledClient = false;
  const client = {
    async hasExistingComment() {
      calledClient = true;
      return false;
    },
  };
  const result = await run({ issue: { pull_request: {}, number: 1 }, entries, client });
  assert.deepEqual(result, []);
  assert.equal(calledClient, false);
});

test("GitHubClient.hasExistingComment matches on the capability-hint marker", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return jsonResponse([{ body: "<!-- dbx-capability-hint -->\nfoo" }, { body: "unrelated" }]);
  };
  try {
    const client = new GitHubClient({ token: "t", repository: "t8y2/dbx" });
    assert.equal(await client.hasExistingComment(1), true);
    assert.match(calls[0], /issues\/1\/comments/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
