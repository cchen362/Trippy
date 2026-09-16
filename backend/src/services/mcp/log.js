// Plan 28 W5.2: a structured, one-line-per-call log for every MCP tool
// invocation. Deliberately narrow — token identity, tool name, timing, and
// outcome only. Never tool arguments, never response bytes, never the
// plaintext token: those can carry booking details (titles, confirmation
// refs, notes) or trip content that does not belong in server logs.
export function formatToolLogLine({ ts, tokenPrefix, userId, tool, durationMs, outcome, draftId }) {
  const parts = [
    `[mcp] ts=${ts}`,
    `token=${tokenPrefix}`,
    `user=${userId}`,
    `tool=${tool}`,
    `ms=${durationMs}`,
    `outcome=${outcome}`,
  ];
  if (draftId != null) parts.push(`draft=${draftId}`);
  return parts.join(' ');
}

// withToolLog wraps one tool's handler so every call is timed and logged,
// regardless of how it resolves. It never changes the handler's own result or
// error — a throw is logged with outcome=threw and rethrown unchanged, never
// swallowed.
export function withToolLog(handler, { tool, tokenPrefix, userId, sink = console.log }) {
  return async (args, ctx) => {
    const start = Date.now();
    try {
      const result = await handler(args, ctx);
      const outcome = result?.isError
        ? `error:${result?.structuredContent?.error || 'error'}`
        : 'ok';
      // draftId is an identifier, not a booking field, so surfacing it in the
      // log (unlike title/notes/etc.) does not leak booking content — prefer
      // the tool's own result over the caller's args when both are present.
      const draftId = result?.structuredContent?.draftId ?? (typeof args?.draftId === 'string' ? args.draftId : null);
      sink(formatToolLogLine({
        ts: new Date().toISOString(),
        tokenPrefix,
        userId,
        tool,
        durationMs: Date.now() - start,
        outcome,
        draftId,
      }));
      return result;
    } catch (error) {
      sink(formatToolLogLine({
        ts: new Date().toISOString(),
        tokenPrefix,
        userId,
        tool,
        durationMs: Date.now() - start,
        outcome: 'threw',
        draftId: typeof args?.draftId === 'string' ? args.draftId : null,
      }));
      throw error;
    }
  };
}
