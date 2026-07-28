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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
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

// Serve the built front-end when it exists, so the shop runs one process.
const webDist = resolve(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
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
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

getDb(); // create/migrate the database before accepting traffic

app.listen(PORT, HOST, () => {
  console.log(`PharmacyPOS API listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
