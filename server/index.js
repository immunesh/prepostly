import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, ROOT } from './config.js';
import { HttpError } from './auth.js';
import { router as authRoutes } from './routes/auth.js';
import { router as brandRoutes } from './routes/brands.js';
import { router as postRoutes } from './routes/posts.js';
import { router as accountRoutes, callbackRouter } from './routes/accounts.js';
import { router as publishRoutes } from './routes/publish.js';
import { router as ideaRoutes } from './routes/ideas.js';
import { router as intelRoutes } from './routes/intel.js';
import { router as commerceRoutes } from './routes/commerce.js';
import { router as autopilotRoutes } from './routes/autopilot.js';
import { router as analyticsRoutes } from './routes/analytics.js';
import { router as teamRoutes } from './routes/team.js';
import { router as adminRoutes } from './routes/admin.js';
import { router as billingRoutes, dodoWebhook } from './routes/billing.js';
import { router as publicRoutes, v1Router } from './routes/public.js';
import { router as mcpRoutes } from './routes/mcp.js';
import { router as legalRoutes } from './routes/legal.js';
import { startScheduler } from './scheduler.js';
import { resumePending } from './generate.js';
import { writerName } from './engines/llm.js';
import { meterRequests } from './usage.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.set('x-content-type-options', 'nosniff');
    res.set('referrer-policy', 'strict-origin-when-cross-origin');
    next();
  });
  // Payment webhooks are verified against the raw bytes, so they skip JSON parsing.
  app.post('/api/billing/webhook/dodo', express.raw({ type: '*/*', limit: '1mb' }), dodoWebhook);
  app.use(express.json({ limit: '2mb' }));
  // After body parsing, so each handler runs inside its own request's meter.
  app.use(meterRequests);

  app.get('/healthz', (_req, res) => res.json({ ok: true, writer: writerName() }));

  // Rendered media must be publicly fetchable: Instagram, Threads, Pinterest and TikTok pull it by URL.
  const longCache = { maxAge: '7d', immutable: true, fallthrough: false };
  app.use('/media', express.static(path.join(config.dataDir, 'media'), longCache));
  // User uploads can include SVG; a strict CSP keeps them from running script on our origin.
  app.use('/uploads', (_req, res, next) => { res.set('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"); next(); }, express.static(path.join(config.dataDir, 'uploads'), longCache));
  app.use('/outbox', (_req, res, next) => { res.set('content-security-policy', "default-src 'none'; sandbox"); next(); }, express.static(path.join(config.dataDir, 'outbox'), { fallthrough: false }));

  const api = [authRoutes, brandRoutes, postRoutes, accountRoutes, publishRoutes, ideaRoutes, intelRoutes, commerceRoutes, autopilotRoutes, analyticsRoutes, teamRoutes, billingRoutes, adminRoutes];
  app.use('/api', publicRoutes, ...api);
  // Developer REST API (API-key auth) exposes the same resources.
  app.use('/v1', v1Router, postRoutes, accountRoutes, publishRoutes, commerceRoutes);
  app.use(mcpRoutes);
  app.use(callbackRouter);
  app.use(legalRoutes);
  app.use(['/api', '/v1'], (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // Web app.
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|v1\/|media\/|uploads\/|outbox\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, 'That file is too large.');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'The request body is not valid JSON.');
    const status = err.status || 500;
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on our side.' : err.message, code: err.code || 'server_error' });
  });
  return app;
}

export function start({ port = config.port, host = config.host } = {}) {
  const app = createApp();
  resumePending();
  startScheduler();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      const addr = server.address();
      console.log(`Prepostly running at http://${host}:${addr.port}  (writer: ${writerName()})`);
      resolve(server);
    });
    // Outlive client keep-alive pools so reused sockets aren't closed mid-request.
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
