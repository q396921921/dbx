import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/5941 and the follow-up
// race identified on https://github.com/t8y2/dbx/pull/6332:
//
// When an in-flight AI request is stuck (e.g. a hung MCP tool call / slow provider
// response), clicking the clear-chat trash icon, "New Chat", deleting the active
// conversation, or switching to a different saved conversation must (a) cancel the
// in-flight request so `isGenerating` doesn't stay stranded true forever, and (b)
// isolate that in-flight request's async event callbacks / catch / finally from
// whatever conversation is active by the time they run — even if the backend cancel
// RPC itself is a no-op because the request hadn't registered a session id yet.
//
// (b) is what `AiGenerationGuard` (lib/ai/aiGenerationGuard.ts) exists for; its own
// spec (lib/__tests__/ai/aiGenerationGuard.spec.ts) exercises the two races requested
// in review with real async ordering ("cancel before stream registration" and "cancel
// then immediately send a new request, old one resolves later"). This file instead
// pins that AiAssistant.vue actually *wires* the guard at every point that touches
// shared state, following this repo's established pattern for wiring checks on this
// component (see AiAssistant.messageCopy.spec.ts): assert against the component's own
// source text rather than mounting it, since AiAssistant.vue pulls in a large number
// of stores/composables. A real end-to-end browser repro (stub HTTP server simulating
// a stalled AI provider stream + real dbx-web backend + real UI) was used to confirm
// the underlying before/after runtime behavior.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

function bodyOf(fnSignature: string): string {
  const start = source.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in AiAssistant.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${fnSignature}"`);
}

describe("AI assistant clear/switch cancels an in-flight request (issue #5941, PR #6332)", () => {
  it("abandonInFlightRequest() invalidates the generation guard before/regardless of the backend RPC", () => {
    const body = bodyOf("function abandonInFlightRequest()");
    expect(body).toContain("aiGenerationGuard.invalidate();");
    expect(body).toContain("isGenerating.value = false;");
    expect(body).toContain('currentSessionId.value = "";');
    // Invalidation (and resetting isGenerating/currentSessionId/delta buffers) must
    // happen unconditionally and before the best-effort backend RPC, so a send()
    // that hasn't registered a session id yet is still cut off from shared state.
    expect(body.indexOf("aiGenerationGuard.invalidate();")).toBeLessThan(body.indexOf("if (sessionId) {"));
  });

  it("clearMessages() abandons a stuck stream before wiping history", () => {
    const body = bodyOf("function clearMessages()");
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    // The abandon guard must run before the history is actually wiped, not after.
    expect(body.indexOf("if (isGenerating.value) abandonInFlightRequest();")).toBeLessThan(body.indexOf("messages.value = []"));
  });

  it("selectConversation() abandons a stuck stream before switching conversations", () => {
    const body = bodyOf("function selectConversation(conv: AiConversation)");
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    expect(body.indexOf("if (isGenerating.value) abandonInFlightRequest();")).toBeLessThan(body.indexOf("conversationId.value = conv.id;"));
  });

  it("cancelStream() forces the abandon path if the backend never actually stops the stream", () => {
    // Reviewed on PR #6332: the backend cancel RPC only *requests* cancellation
    // (a tokio::sync::Notify) — a hung MCP tool call isn't listening for it while
    // executing (agent_loop.rs), so send()'s own finally may never run on its own.
    // cancelStream() must not invalidate immediately (the common case — backend
    // actually stops promptly — should still go through send()'s normal
    // persistConversation()/agent-step-building cleanup), but it must force the
    // same abandon path clear/switch use if the backend hasn't actually stopped
    // the stream within a bounded grace period, so Stop can never leave
    // isGenerating stranded the way issue #5941 originally reported.
    const body = bodyOf("async function cancelStream()");
    const rpcIdx = body.indexOf("await aiCancelStream(");
    const waitIdx = body.indexOf("await waitForGenerationToClear(STOP_FORCE_ABANDON_MS);");
    const abandonIdx = body.indexOf("abandonInFlightRequest();");
    expect(rpcIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(rpcIdx);
    expect(abandonIdx).toBeGreaterThan(waitIdx);
    // Must re-check currentSessionId too, not just isGenerating — a newer send()
    // may have legitimately started (cancel, then immediately send again) during
    // the grace period and must not be torn down by this stale Stop click.
    expect(body).toContain("isGenerating.value && currentSessionId.value === sessionId");
  });

  it("startNewChat() and deleteConversation() funnel through the guarded clearMessages()", () => {
    expect(bodyOf("function startNewChat()")).toContain("clearMessages();");
    expect(bodyOf("async function deleteConversation(id: string)")).toContain("clearMessages();");
  });

  it("send() claims a generation id right after setting isGenerating and re-checks it after the first await", () => {
    const sendBody = bodyOf("async function send()");
    const claimIdx = sendBody.indexOf("const myGeneration = aiGenerationGuard.begin();");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(sendBody.indexOf("isGenerating.value = true;")).toBeLessThan(claimIdx);
    // Must re-validate after the first await point (ensureLoaded()) before doing
    // anything that touches messages/mentions belonging to whatever conversation
    // is current by the time it resolves.
    const ensureLoadedAwaitIdx = sendBody.indexOf("await promptTemplateStore.ensureLoaded()");
    const recheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration))", ensureLoadedAwaitIdx);
    expect(ensureLoadedAwaitIdx).toBeGreaterThan(claimIdx);
    expect(recheckIdx).toBeGreaterThan(ensureLoadedAwaitIdx);
  });

  it("send() clears the pending write-SQL grant when superseded before it's consumed", () => {
    // Reviewed on PR #6332: at this point in send(), the write-SQL grant
    // (allowWriteSqlForNextRun/confirmedWriteSqlText/...) hasn't been read/reset
    // yet — that happens later, right before runAgentStream(). A bare `return`
    // here would leave a previously-confirmed write grant sitting in the
    // module-scope vars, live to be replayed against whatever unrelated send()
    // the next conversation issues.
    const sendBody = bodyOf("async function send()");
    const ensureLoadedAwaitIdx = sendBody.indexOf("await promptTemplateStore.ensureLoaded()");
    const grantConsumedIdx = sendBody.indexOf("const allowWriteSql = requestedMode", ensureLoadedAwaitIdx);
    const recheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) {", ensureLoadedAwaitIdx);
    expect(recheckIdx).toBeGreaterThan(ensureLoadedAwaitIdx);
    expect(recheckIdx).toBeLessThan(grantConsumedIdx);
    const recheckEnd = sendBody.indexOf("}", recheckIdx);
    const recheckBlock = sendBody.slice(recheckIdx, recheckEnd);
    expect(recheckBlock).toContain("clearPendingWriteGrant();");
    expect(recheckBlock).toContain("return;");
  });

  it("send()'s agent-event callback bails immediately if superseded", () => {
    const sendBody = bodyOf("async function send()");
    const callbackStart = sendBody.indexOf("(event: AgentEvent) => {");
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    const guardIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", callbackStart);
    const pushIdx = sendBody.indexOf("agentEvents.push(event);", callbackStart);
    expect(guardIdx).toBeGreaterThan(callbackStart);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it("send()'s catch block guards the assistant message lookup behind the generation check", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} catch (e: unknown) {");
    expect(start, 'expected to find a "} catch (e: unknown) {" block inside send()').toBeGreaterThanOrEqual(0);
    const end = sendBody.indexOf("} finally {", start);
    const catchBody = sendBody.slice(start, end);
    // Must not index messages.value[assistantIdx] unguarded — if clearMessages()/
    // selectConversation() already replaced the array (or invalidated the
    // generation) while this request was still in flight, an unguarded write would
    // either throw (silently eating the real error) or corrupt a different
    // conversation's transcript.
    expect(catchBody).not.toContain("messages.value[assistantIdx].content =");
    expect(catchBody).toContain("aiGenerationGuard.isCurrent(myGeneration)");
    expect(catchBody).toContain("const msg = messages.value[assistantIdx];");
    expect(catchBody).toContain("if (msg) msg.content =");
  });

  it("send()'s finally block only mutates shared state (isGenerating, currentSessionId) when still current", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} finally {");
    expect(start).toBeGreaterThanOrEqual(0);
    const finallyBody = sendBody.slice(start);
    const guardIdx = finallyBody.indexOf("if (aiGenerationGuard.isCurrent(myGeneration)) {");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const isGeneratingIdx = finallyBody.indexOf("isGenerating.value = false;");
    const sessionResetIdx = finallyBody.indexOf('currentSessionId.value = "";');
    expect(isGeneratingIdx).toBeGreaterThan(guardIdx);
    expect(sessionResetIdx).toBeGreaterThan(guardIdx);
  });

  // The three gaps below were called out on review of PR #6332: the generation guard
  // stopped *writes* from a superseded generation, but didn't stop the generation from
  // starting a stream, leaking pending-compaction state, or from surviving unmount.
  it("send() rechecks the generation after EACH context-preparation await, before ever starting the stream", () => {
    const sendBody = bodyOf("async function send()");
    const sqlFilesIdx = sendBody.indexOf("await loadReferencedSqlFiles(");
    const firstRecheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", sqlFilesIdx);
    const contextIdx = sendBody.indexOf("const context = await buildAiContext(");
    const secondRecheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", contextIdx);
    const runIdx = sendBody.indexOf("await runAgentStream(", contextIdx);
    // A clear/switch/unmount firing during EITHER await invalidates the generation
    // but doesn't touch the backend (no session registered yet) — without a
    // recheck immediately after each one, send() would resume into further wasted
    // work (buildAiContext() can do real backend/schema work) and eventually call
    // runAgentStream() anyway, starting a request nobody can reach anymore.
    expect(sqlFilesIdx).toBeGreaterThanOrEqual(0);
    expect(firstRecheckIdx).toBeGreaterThan(sqlFilesIdx);
    expect(firstRecheckIdx).toBeLessThan(contextIdx);
    expect(secondRecheckIdx).toBeGreaterThan(contextIdx);
    expect(runIdx).toBeGreaterThan(secondRecheckIdx);
  });

  it("resetPendingRequestState() resets all per-request transient state, and abandonInFlightRequest() uses it", () => {
    // Reviewed on PR #6332: this reset logic used to be duplicated inline across
    // send()'s finally, abandonInFlightRequest(), and flushAssistantDeltas() —
    // duplication that already let the pendingCompaction reset get missed once.
    // Consolidating it into one function means a newly-added piece of per-request
    // state only needs to be added here to be covered by the abandon path.
    const resetBody = bodyOf("function resetPendingRequestState()");
    expect(resetBody).toContain("cancelAnimationFrame(assistantDeltaFrame);");
    expect(resetBody).toContain("assistantDeltaFrame = null;");
    expect(resetBody).toContain('pendingAssistantDelta = "";');
    expect(resetBody).toContain('pendingAssistantReasoning = "";');
    expect(resetBody).toContain("pendingAssistantIndex = -1;");
    // A context_compacted event on the abandoned generation may have already set
    // pendingCompaction before invalidation took effect. It's request-owned, not
    // conversation-owned, so it must be reset here — otherwise the next send() (in
    // a brand-new, just-cleared conversation) would splice the OLD conversation's
    // compaction summary into the NEW conversation's transcript in its finally
    // block.
    expect(resetBody).toContain("pendingCompaction.value = null;");

    const abandonBody = bodyOf("function abandonInFlightRequest()");
    expect(abandonBody).toContain("resetPendingRequestState();");
  });

  it("onUnmounted() invalidates the generation instead of only firing the best-effort cancel RPC", () => {
    const body = bodyOf("onUnmounted(() => {");
    // Plain cancelStream() leaves the generation current: a request still mid-await
    // when the component unmounts would resume, call runAgentStream(), and its event
    // callback/catch/finally would keep writing into refs this now-unmounted
    // instance's closures still hold. Must go through the same invalidating path as
    // clearMessages()/selectConversation().
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    expect(body).not.toContain("cancelStream();");
  });
});
