import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/5941:
// when an in-flight AI request is stuck (e.g. a hung MCP tool call / slow
// provider response), clicking the clear-chat trash icon, "New Chat", or
// switching to a different saved conversation wiped the message history
// (`messages.value = []` / reassignment) WITHOUT cancelling the in-flight
// request or resetting `isGenerating`. Because `isGenerating` is only ever
// reset in send()'s own `finally` block, the send box stayed disabled
// indefinitely (until the abandoned request eventually settled on its own,
// which — for a hung streaming response — can be never), even though the
// visible chat history had already been cleared.
//
// This repo's established pattern for wiring checks on this component
// (see AiAssistant.messageCopy.spec.ts) asserts against the component's own
// source text rather than mounting the full component, since AiAssistant.vue
// pulls in a large number of stores/composables. A real end-to-end browser
// repro (stub HTTP server simulating a stalled AI provider stream + real
// dbx-web backend + real UI) was used to confirm the actual before/after
// runtime behavior for this fix; these assertions pin the exact code shape
// that repro validated so a future edit can't silently drop the guard.
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

describe("AI assistant clear/switch cancels an in-flight request (issue #5941)", () => {
  it("clearMessages() cancels a stuck stream before wiping history", () => {
    const body = bodyOf("function clearMessages()");
    expect(body).toContain("if (isGenerating.value) cancelStream();");
    // The cancel guard must run before the history is actually wiped, not after.
    expect(body.indexOf("if (isGenerating.value) cancelStream();")).toBeLessThan(body.indexOf("messages.value = []"));
  });

  it("selectConversation() cancels a stuck stream before switching conversations", () => {
    const body = bodyOf("function selectConversation(conv: AiConversation)");
    expect(body).toContain("if (isGenerating.value) cancelStream();");
    expect(body.indexOf("if (isGenerating.value) cancelStream();")).toBeLessThan(body.indexOf("conversationId.value = conv.id;"));
  });

  it("startNewChat() and deleteConversation() funnel through the guarded clearMessages()", () => {
    expect(bodyOf("function startNewChat()")).toContain("clearMessages();");
    expect(bodyOf("async function deleteConversation(id: string)")).toContain("clearMessages();");
  });

  it("send()'s catch block guards the assistant message lookup like its finally block does", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} catch (e: unknown) {");
    expect(start, 'expected to find a "} catch (e: unknown) {" block inside send()').toBeGreaterThanOrEqual(0);
    const end = sendBody.indexOf("} finally {", start);
    const catchBody = sendBody.slice(start, end);
    // Must not index messages.value[assistantIdx] unguarded — if clearMessages()/
    // selectConversation() already replaced the array while this request was still
    // in flight, that throws and silently eats the real error message.
    expect(catchBody).not.toContain("messages.value[assistantIdx].content =");
    expect(catchBody).toContain("const msg = messages.value[assistantIdx];");
    expect(catchBody).toContain("if (msg) msg.content =");
  });
});
