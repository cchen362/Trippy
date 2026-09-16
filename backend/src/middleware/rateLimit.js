import rateLimit from 'express-rate-limit';

export const AUTH_RATE_LIMIT = process.env.NODE_ENV === 'test' ? 5 : 20;

// Auth endpoints are the only public, unauthenticated surface — throttle by IP
// to blunt credential-stuffing / brute force against the login form.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// Plan 28 W1: two limiters guard /mcp (routes/mcp.js) — one for verified
// tokens, one for the 401 path — so each throttles the traffic it can actually see.
export const MCP_TOKEN_RATE_LIMIT = 120;
export const MCP_ANON_RATE_LIMIT = 30;

// Mounted AFTER the bearer check, so req.auth is populated — keys by the
// token's own clientId rather than IP, so one client's usage never throttles
// another sharing a NAT/proxy IP. A single subscriptions/listen SSE stream
// (Claude Code keeps one open per session) counts as one request at open
// time; there is deliberately no in-flight/streaming accounting here.
export const mcpTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: MCP_TOKEN_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth.clientId,
  message: { error: 'Too many requests' },
});

// Invoked from routes/mcp.js only when bearer verification has already
// FAILED, keyed by IP (the default keyGenerator). Every request it sees is a
// 401, so it bounds credential-guessing against /mcp while a valid token from
// the same IP is never counted and never blocked.
export const mcpAnonLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: MCP_ANON_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
