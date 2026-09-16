// Plan 28 W1 (D-28-1): bearer verification is hand-written rather than the
// SDK's requireBearerAuth, which rejects any token with no `expiresAt` — our
// integration tokens are allowed to be non-expiring (Q-28-1). The metadata
// router below is also hand-written rather than the SDK's
// mcpAuthMetadataRouter, which requires RFC 8414 authorization-server
// metadata; Trippy has no authorization server (D-28-1), and RFC 9728 makes
// `authorization_servers` optional on the protected-resource document, so we
// simply omit it.
import { Router } from 'express';
import express from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { verifyToken as defaultVerify, SCOPES } from '../services/integrationTokens.js';
import { createTrippyMcpServer } from '../services/mcp/server.js';
import { mcpAnonLimiter, mcpTokenLimiter } from '../middleware/rateLimit.js';
import { MEDIA_TYPE_WHITELIST } from '../services/attachments.js';
import { consumeUploadTicket } from '../services/mcp/uploads.js';

function requireAbsoluteHttpUrl(value, label) {
  if (!value) {
    throw new Error(`${label} is required when MCP is enabled`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  return parsed;
}

export function createMcpRouter({ publicUrl, frontendUrl, verify = defaultVerify, appUrl }) {
  const publicUrlParsed = requireAbsoluteHttpUrl(publicUrl, 'publicUrl');
  const metadataUrl = `${publicUrlParsed.origin}/.well-known/oauth-protected-resource${publicUrlParsed.pathname}`;

  const nodeHandler = toNodeHandler(
    createMcpHandler(
      (ctx) => createTrippyMcpServer({ authInfo: ctx.authInfo, appUrl, publicUrl }),
      { legacy: 'stateless', onerror: (error) => console.error('[mcp]', error) },
    ),
  );

  const router = Router();

  // Streamed SSE responses must reach the client immediately — an intermediary
  // buffering the stream would stall it (and Trippy's prod ingress is a
  // Cloudflare Tunnel with a 100s no-bytes timeout, so buffering could also
  // trip that).
  router.use((req, res, next) => {
    res.setHeader('X-Accel-Buffering', 'no');
    next();
  });

  router.get('/', (req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
  });
  router.delete('/', (req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
  });

  router.post(
    '/',
    (req, res, next) => {
      // Deny-on-failure: a present Origin that is unparseable (browsers send the
      // literal "null" for opaque origins) is refused, not crashed on.
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          allowed = new URL(origin).origin === new URL(frontendUrl).origin;
        } catch {
          allowed = false;
        }
        if (!allowed) return res.status(403).json({ error: 'forbidden_origin' });
      }
      next();
    },
    express.json({ limit: '1mb' }),
    async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization || '';
        const match = /^Bearer (.+)$/.exec(authHeader);
        const token = match ? match[1] : null;
        const verified = token ? await verify(token) : null;

        if (!verified) {
          // The per-IP limiter runs only on this failure branch, so a spent
          // 401 budget can never lock out a valid token from the same IP —
          // express-rate-limit checks its counter before the request runs, so
          // mounting it ahead of verification would do exactly that.
          return mcpAnonLimiter(req, res, () => {
            res.setHeader(
              'WWW-Authenticate',
              `Bearer error="invalid_token", error_description="The access token is missing or invalid", resource_metadata="${metadataUrl}"`,
            );
            res.status(401).json({ error: 'invalid_token', error_description: 'The access token is missing or invalid' });
          });
        }

        req.auth = {
          token,
          clientId: verified.id,
          scopes: verified.scopes,
          expiresAt: verified.expiresAt ? Math.floor(Date.parse(verified.expiresAt) / 1000) : undefined,
          extra: { userId: verified.userId, tokenId: verified.id },
        };
        next();
      } catch (error) {
        next(error);
      }
    },
    mcpTokenLimiter,
    (req, res) => nodeHandler(req, res, req.body),
  );

  // Plan 28 W3.4: the ticket id in the URL IS the credential for this one PUT —
  // deliberately no bearer check and no Origin check, unlike POST / above.
  // F-28-24: this is also why the global 16MB express.json() parser in
  // index.js must never reach this route — a JSON body-parser would choke on
  // (or silently drop) raw binary attachment bytes, so the raw parser below
  // is mounted ahead of it via the same /mcp-first mount order that already
  // protects POST /'s 1MB json() parser. A Content-Type outside
  // MEDIA_TYPE_WHITELIST leaves req.body as `{}` (not a Buffer);
  // consumeUploadTicket turns that into a clean 415. A body over the 10MB
  // limit here throws body-parser's own `entity.too.large` (413), rendered as
  // JSON by the app's errorHandler below — Cloudflare itself passes up to
  // 100MB (F-28-14 c), so this 10MB cap is Trippy's own ceiling, sized to the
  // largest attachment kind (SIZE_CAPS.pdf in services/attachments.js).
  router.put(
    '/uploads/:ticket',
    express.raw({ limit: '10mb', type: MEDIA_TYPE_WHITELIST }),
    (req, res, next) => {
      try {
        const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
        const { httpStatus, attachment, alreadyAttached } = consumeUploadTicket(req.params.ticket, {
          body: req.body,
          contentType,
        });
        res.status(httpStatus).json({
          attachmentId: attachment.id,
          bookingId: attachment.bookingId,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
          alreadyAttached,
        });
      } catch (err) {
        if (err.code && err.status) {
          return res.status(err.status).json({ error: err.code, message: err.message });
        }
        next(err);
      }
    },
  );

  const metadataRouter = Router();
  const metadataBody = {
    resource: publicUrl,
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Trippy',
  };
  metadataRouter.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json(metadataBody);
  });
  metadataRouter.get(`/.well-known/oauth-protected-resource${publicUrlParsed.pathname}`, (req, res) => {
    res.json(metadataBody);
  });

  return { router, metadataRouter, handler: nodeHandler };
}
