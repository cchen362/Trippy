import { Router } from 'express';
import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { MCP_PROTOCOL_VERSIONS } from '../services/mcp/server.js';

const router = Router();

router.get('/', (req, res) => {
  const mcp = { enabled: config.mcpEnabled, protocolVersions: MCP_PROTOCOL_VERSIONS };
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'connected', mcp });
  } catch (err) {
    console.error('[health] DB check failed:', err);
    res.status(503).json({ status: 'error', db: 'disconnected', mcp });
  }
});

export default router;
