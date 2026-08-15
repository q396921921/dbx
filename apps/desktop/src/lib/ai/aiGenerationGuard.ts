/**
 * Tracks which in-flight `send()` invocation ("generation") is still allowed to
 * write into the AI assistant's shared reactive state (`messages`, `isGenerating`,
 * `currentSessionId`, the streaming delta buffers).
 *
 * `messages`/`isGenerating` are plain component refs, not per-conversation state.
 * Clearing the chat, switching to a different saved conversation, or starting a
 * new one replaces `messages.value` and must invalidate whatever `send()` call is
 * still running — otherwise its async event callbacks, `catch`, or `finally` can
 * keep writing into the array that now belongs to a different conversation, or
 * clear `isGenerating` for a request that has nothing to do with them.
 *
 * The backend cancel RPC is a best-effort companion to this guard, not a
 * substitute for it: it depends on the stream having already registered a
 * session id, which happens partway through `send()`. If clear/switch fires
 * before that registration, the backend call is a no-op — but `invalidate()`
 * still takes effect immediately and synchronously, so the superseded
 * generation's callbacks stop touching shared state regardless of whether the
 * backend was actually told to stop.
 */
export class AiGenerationGuard {
  private current = 0;

  /** Starts a new generation and returns its id. Call once per `send()` invocation. */
  begin(): number {
    this.current += 1;
    return this.current;
  }

  /** Invalidates whatever generation is currently active (clear / switch / new chat / explicit cancel). */
  invalidate(): void {
    this.current += 1;
  }

  /** True when `generation` is still the active one and may write shared state. */
  isCurrent(generation: number): boolean {
    return generation === this.current;
  }
}
