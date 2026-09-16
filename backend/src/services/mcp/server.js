// Plan 28 W1 (D-28-2): must-work MCP clients are Claude Code, Codex CLI, MCP
// Inspector, and the owner's bot. The W0 spike found SDK v2's dual-era routing
// serves all four from one factory — 2026-07-28 traffic gets the `_meta`
// envelope, 2025-era traffic gets the legacy wire — with no per-client branch
// anywhere in this module or in routes/mcp.js.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { registerReadTools, registerWriteTools } from './tools.js';
import { withToolLog } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));

// SUPPORTED_PROTOCOL_VERSIONS is the legacy (2025-era) list only — health must
// report the modern envelope revision alongside it so a probing client can
// see the server's full supported range in one place.
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS];

export function createTrippyMcpServer({ authInfo, appUrl, publicUrl, logSink }) {
  const userId = authInfo?.extra?.userId;
  if (!userId) {
    // The factory must never run unauthenticated — routes/mcp.js's bearer
    // middleware is the only thing allowed to populate authInfo.extra.userId,
    // so reaching here without it means that contract was broken upstream.
    throw Object.assign(new Error('createTrippyMcpServer requires an authenticated authInfo'), { status: 500 });
  }

  // Plan 28 W2: `logging` capability declared so a client that sends no
  // progressToken (e.g. a raw fetch tools/call) still gets the SSE upgrade
  // apply_draft's notifications/message fallback needs to keep Cloudflare's
  // keep-alive flowing — without a declared capability the SDK would refuse
  // to emit notifications/message at all.
  const server = new McpServer({ name: 'trippy', version: packageJson.version }, { capabilities: { logging: {} } });
  const tokenId = authInfo.clientId;

  // Plan 28 W5.2: wrap registerTool once, before any tool is registered, so
  // every tool from registerReadTools/registerWriteTools gets a structured
  // log line for free — tools.js itself stays untouched.
  const tokenPrefix = authInfo?.extra?.tokenPrefix;
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    originalRegisterTool(name, config, withToolLog(handler, { tool: name, tokenPrefix, userId, sink: logSink }));

  registerReadTools(server, { userId, scopes: authInfo.scopes || [], appUrl });
  registerWriteTools(server, { userId, tokenId, scopes: authInfo.scopes || [], appUrl, publicUrl });
  return server;
}
