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
import healthRoutes from './routes/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

if (config.isProd) {
  app.use(express.static(join(__dirname, '../../frontend/dist')));
}

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);

if (config.isProd) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(__dirname, '../../frontend/dist/index.html'));
    }
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
