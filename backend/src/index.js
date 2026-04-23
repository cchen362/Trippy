import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';

const app = express();

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use(errorHandler);

function start() {
  initDb(config.dbPath);
  runMigrations();
  app.listen(config.port, () => {
    console.log(`Trippy backend running on :${config.port} [${config.nodeEnv}]`);
  });
}

start();
