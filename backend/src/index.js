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
import dayRoutes from './routes/days.js';
import healthRoutes from './routes/health.js';
import lookupRoutes from './routes/lookups.js';
import mapRoutes from './routes/map.js';
import stopRoutes from './routes/stops.js';
import tripRoutes from './routes/trips.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/trips', mapRoutes);
app.use('/api', dayRoutes);
app.use('/api', stopRoutes);
app.use('/api', bookingRoutes);
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

function start() {
  initDb(config.dbPath);
  runMigrations();

  if (config.nodeEnv === 'development') {
    const adminUser = getDb().prepare('SELECT id FROM users WHERE is_admin = 1').get();
    if (adminUser) seedIfEmpty(adminUser.id);
  }

  app.listen(config.port, () => {
    console.log(`Trippy backend running on :${config.port} [${config.nodeEnv}]`);
  });
}

start();
