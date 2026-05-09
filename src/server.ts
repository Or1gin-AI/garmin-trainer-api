import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import { meRouter } from './routes/me.js';
import { garminRouter } from './routes/garmin.js';
import { syncRouter } from './routes/sync.js';
import { redemptionRouter } from './routes/redemption.js';
import { adminRouter } from './routes/admin.js';
import { adminAiRouter } from './routes/admin-ai.js';

const app = express();

const port = Number(process.env.PORT || 4000);
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);

// BetterAuth handler — must be mounted BEFORE express.json()
// because BetterAuth needs the raw request body.
app.all('/api/auth/*splat', toNodeHandler(auth));

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api/me', meRouter);
app.use('/api/garmin', garminRouter);
app.use('/api/sync', syncRouter);
app.use('/api/redemption', redemptionRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', adminAiRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[api error]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  },
);

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
  console.log(`[api] CORS origins: ${corsOrigins.join(', ')}`);
});
