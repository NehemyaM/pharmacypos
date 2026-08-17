import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, DB_PATH } from './db/index.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { productsRouter, suppliersRouter, customersRouter, doctorsRouter } from './routes/masters.js';
import { salesRouter } from './routes/sales.js';
import { purchasesRouter } from './routes/purchases.js';
import { returnsRouter } from './routes/returns.js';
import { inventoryRouter } from './routes/inventory.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { exportsRouter } from './routes/exports.js';
import { backupRouter } from './routes/backup.js';
import { purchaseReturnsRouter } from './routes/purchase-returns.js';
import { supplierLedgerRouter } from './routes/supplier-ledger.js';
import { heldBillsRouter } from './routes/held-bills.js';
import { customerLedgerRouter } from './routes/customer-ledger.js';
import { importRouter } from './routes/import.js';
import { readinessRouter } from './routes/readiness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

/** A refused origin is a policy decision, not a server fault — see below. */
class CorsError extends Error {
  constructor(readonly origin: string) {
    super(`Origin not allowed: ${origin}`);
    this.name = 'CorsError';
  }
}

const app = express();

/**
 * CORS.
 *
 * Same-origin deployments (one process serving UI and API) never need this.
 * It matters when the UI is hosted separately — e.g. Firebase Hosting talking
 * to a backend on its own machine. Set PHARMACY_ALLOWED_ORIGINS to a comma
 * separated list; anything not listed is refused rather than reflected back.
 */
const allowedOrigins = (process.env.PHARMACY_ALLOWED_ORIGINS ?? '')
  .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // No Origin header: same-origin request, curl, or a health probe.
    if (!origin) return callback(null, true);
    // Unconfigured means local development — allow, but say so once at boot.
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new CorsError(origin));
  },
  credentials: false, // auth travels in the Authorization header, not cookies
}));

// Behind Caddy/nginx/a load balancer, so req.ip and rate limiting see the
// real client rather than the proxy.
app.set('trust proxy', 1);

// A catalogue import carries the whole product list in one request. A shop with
// three thousand lines and a distributor's wide column set runs to a few MB, so
// this route gets a larger ceiling than everything else — and it is registered
// first, because the global parser below would otherwise reject the body before
// this one saw it.
app.use('/api/import', express.json({ limit: '32mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: DB_PATH, time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/customers', customersRouter);
app.use('/api/doctors', doctorsRouter);
app.use('/api/sales', salesRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/returns', returnsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/exports', exportsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/purchase-returns', purchaseReturnsRouter);
app.use('/api/supplier-ledger', supplierLedgerRouter);
app.use('/api/held-bills', heldBillsRouter);
app.use('/api/customer-ledger', customerLedgerRouter);
app.use('/api/import', importRouter);
app.use('/api/readiness', readinessRouter);

// Serve the built front-end when it exists, so the shop runs one process.
const webDist = resolve(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // Client-side routes fall through to index.html. Requests that look like a
  // file (anything with an extension) must not, or a missing asset would come
  // back as HTML with a 200 and hide the problem.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.path)) {
      next();
      return;
    }
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // A refused origin means this deployment is misconfigured, not broken.
  // Returning 500 would send whoever debugs it looking for a server fault.
  if (err instanceof CorsError) {
    console.warn(`[cors] refused ${err.origin} (allowed: ${allowedOrigins.join(', ') || 'none set'})`);
    res.status(403).json({
      error: 'This site is not allowed to call the API. '
        + 'Add its origin to PHARMACY_ALLOWED_ORIGINS on the server.',
    });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

getDb(); // create/migrate the database before accepting traffic

app.listen(PORT, HOST, () => {
  console.log(`PharmacyPOS API listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(existsSync(webDist)
    ? `Serving the UI from ${webDist}`
    : 'UI build not found — API only (fine when the UI is hosted separately)');
  console.log(allowedOrigins.length > 0
    ? `CORS restricted to: ${allowedOrigins.join(', ')}`
    : 'CORS open to all origins — set PHARMACY_ALLOWED_ORIGINS before exposing this publicly');
  if (!process.env.PHARMACY_JWT_SECRET) {
    console.log('PHARMACY_JWT_SECRET not set — using the generated secret beside the database');
  }
});
