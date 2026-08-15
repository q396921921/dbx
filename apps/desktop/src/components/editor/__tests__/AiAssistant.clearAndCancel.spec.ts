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

  it("cancelStream() (the plain stop-generating button) does not invalidate the generation", () => {
    // cancelStream() is used by the stop button and onUnmounted, where the SAME
    // conversation stays current — send()'s own finally still owns cleanup once
    // the backend acknowledges the cancellation. Only abandonInFlightRequest()
    // (clear/switch/new chat) needs to force an immediate, synchronous reset.
    // If this ever regresses to always invalidating, a plain stop-click would
    // silently start skipping persistConversation()/agent-step building for
    // every cancelled response, not just when the chat is actually being
    // cleared/switched.
    const body = bodyOf("async function cancelStream()");
    expect(body).not.toContain("aiGenerationGuard.invalidate();");
    expect(body).not.toContain("isGenerating.value = false;");
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
    const recheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;");
    expect(recheckIdx).toBeGreaterThan(claimIdx);
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
});
