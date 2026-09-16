import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initDb, getDb } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { seedIfEmpty } from './db/seed.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import collaborationRoutes from './routes/collaboration.js';
import dayRoutes from './routes/days.js';
import copilotRoutes from './routes/copilot.js';
import discoveryRoutes, { discoveryPlacesRouter } from './routes/discovery.js';
import expenseRoutes from './routes/expenses.js';
import healthRoutes from './routes/health.js';
import importRoutes from './routes/imports.js';
import integrationRoutes from './routes/integrations.js';
import lookupRoutes from './routes/lookups.js';
import mapRoutes from './routes/map.js';
import shareRoutes from './routes/share.js';
import stopRoutes from './routes/stops.js';
import tripRoutes from './routes/trips.js';
import { createMcpRouter } from './routes/mcp.js';
import { installShutdownHandlers } from './shutdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));

// F-28-22: /mcp mounts its own 1MB JSON parser inside createMcpRouter, which
// must run before the global 16MB parser below claims the body first.
if (config.mcpEnabled) {
  const mcp = createMcpRouter({ publicUrl: config.mcpPublicUrl, frontendUrl: config.frontendUrl, appUrl: config.frontendUrl });
  app.use('/mcp', mcp.router);
  app.use(mcp.metadataRouter);
  // Plan 28 W5.1: mcp.handler is the object createMcpHandler returns
  // ({ fetch, notify, bus, close }), not the Node-shaped fetch face routes/mcp.js
  // uses internally — its close() tears down in-flight modern exchanges and open
  // subscription/listen streams. Kept reachable so the shutdown hook below can call it.
  app.locals.mcpHandler = mcp.handler;
}

// Plan 2A D2: capture uploads ride base64 JSON, not multipart — Claude needs base64
// anyway, so multipart would add a dependency and buy nothing. This limit is what
// makes that work.
app.use(express.json({ limit: '16mb' }));
app.use(cookieParser());

app.use('/api/health', healthRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/trips', collaborationRoutes);
app.use('/api', shareRoutes);
app.use('/api/trips', mapRoutes);
app.use('/api/trips', copilotRoutes);
app.use('/api/trips', discoveryRoutes);
app.use('/api/discovery', discoveryPlacesRouter);
app.use('/api', dayRoutes);
app.use('/api', stopRoutes);
app.use('/api', bookingRoutes);
app.use('/api', expenseRoutes);
app.use('/api', importRoutes);
app.use('/api/lookups', lookupRoutes);

if (config.isProd) {
  const frontendDist = join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

async function start() {
  initDb(config.dbPath);
  await runMigrations();

  if (config.nodeEnv === 'development') {
    const adminUser = getDb().prepare('SELECT id FROM users WHERE is_admin = 1').get();
    if (adminUser) seedIfEmpty(adminUser.id);
  }

  const server = app.listen(config.port, () => {
    console.log(`Trippy backend running on :${config.port} [${config.nodeEnv}]`);
  });

  // Plan 28 W5.1: Docker sends SIGTERM with a 10s default stop timeout before
  // SIGKILL, so shutdownServer's default 5s grace period must stay under that.
  installShutdownHandlers({
    server,
    closeDb: async () => {
      if (app.locals.mcpHandler) await app.locals.mcpHandler.close();
      getDb().close();
    },
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
