/**
 * Reading a distributor's invoice from a photograph or a PDF.
 *
 * Nothing this produces touches stock. The scan yields *candidates*, which a
 * pharmacist reads against the original picture and corrects, and only the
 * corrected version is committed — through the ordinary goods-inward route, so
 * batches, the stock ledger and the supplier's account all move exactly as they
 * do for a hand-typed invoice.
 *
 * That review is not politeness about machine fallibility. A batch number read
 * as PNB0921 instead of PN80921 looks perfectly reasonable on screen, and an
 * expiry read as 2028 instead of 2026 puts expired medicine into the shop's
 * FEFO queue. Neither is catchable by arithmetic; both are obvious to someone
 * holding the invoice.
 */
import { Router } from 'express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getDb, dataDir } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { readInvoice, looksLikePdf } from '../lib/invoice-read.js';
import { parseInvoice, type ScannedLine } from '../lib/invoice-parse.js';
import type { Product } from '../types.js';

export const invoiceScanRouter = Router();

// A pharmacist signs for goods inward; a cashier has no business doing so.
invoiceScanRouter.use(requireAuth, requireRole('admin', 'pharmacist'));

/** Where the uploaded originals live. Kept beside the database, so a backup of
 *  the shop is a backup of its paperwork too. */
function scansDir(): string {
  const dir = join(dataDir(), 'invoice-scans');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Discard scans nobody committed.
 *
 * A shop photographs an invoice, thinks better of it, and walks away; without
 * this the folder grows without limit on a machine with one small disk. A
 * committed scan is not touched here — those are attached to a purchase and are
 * part of the shop's records.
 */
function pruneAbandonedScans(): void {
  const dir = scansDir();
  const db = getDb();
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs > week) continue;
      const id = name.replace(extname(name), '');
      const kept = db.prepare('SELECT 1 FROM purchases WHERE scan_id = ?').get(id);
      if (!kept) unlinkSync(path);
    } catch {
      /* a file that vanished underneath us needs no cleaning up */
    }
  }
}

// ---------------------------------------------------------------------------
// Matching what was read against the shop's own catalogue
// ---------------------------------------------------------------------------

/** Squash to comparable letters and digits: "DOLO 650 TAB" -> "dolo650tab". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find the product a scanned name refers to.
 *
 * Distributors abbreviate — "AUGMENTIN 625 DUO" against a catalogue holding
 * "Augmentin 625 Duo Tablet" — so an exact match is rare and a containment
 * match in either direction is the common case. A weak resemblance is left
 * unmatched on purpose: proposing the wrong medicine is worse than proposing
 * none, because the reviewer is checking quantities and may not question a
 * name that was filled in for them.
 */
export function matchProduct(
  scannedName: string,
  products: Array<Pick<Product, 'id' | 'name' | 'pack_size' | 'gst_rate'>>,
): { product_id: number; confidence: 'exact' | 'likely' } | null {
  const needle = squash(scannedName);
  if (needle.length < 4) return null;

  for (const p of products) {
    if (squash(p.name) === needle) return { product_id: p.id, confidence: 'exact' };
  }
  const contained = products.filter((p) => {
    const hay = squash(p.name);
    return hay.includes(needle) || needle.includes(hay);
  });
  // Two products matching equally well is an ambiguity the reviewer should
  // resolve, not one this should silently pick a side in.
  if (contained.length === 1) return { product_id: contained[0].id, confidence: 'likely' };
  return null;
}

export type ReviewLine = ScannedLine & {
  product_id: number | null;
  matched_name: string;
  match: 'exact' | 'likely' | 'none';
};

// ---------------------------------------------------------------------------
// Upload and read
// ---------------------------------------------------------------------------

/**
 * The raw file arrives as the request body.
 *
 * A phone photograph is a few megabytes; the ceiling is generous enough for one
 * and mean enough that nobody uploads a video by mistake.
 */
const rawBody = express.raw({
  type: ['image/*', 'application/pdf', 'application/octet-stream'],
  limit: '20mb',
});

invoiceScanRouter.post('/', rawBody, async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ error: 'No file was received. Choose a photo or a PDF of the invoice.' });
    return;
  }

  const started = Date.now();
  const read = await readInvoice(buf);

  if (read.problem) {
    res.status(422).json({
      error: read.problem,
      source: read.source,
      words_read: read.words.length,
    });
    return;
  }

  const invoice = parseInvoice(read.words);

  if (invoice.lines.length === 0) {
    res.status(422).json({
      error: 'The invoice was found but no line items could be read from it. '
        + 'A flat, straight-on photo in good light, or a PDF from your distributor, reads far better.',
      source: read.source,
      words_read: read.words.length,
    });
    return;
  }

  // Keep the original. The reviewer needs to see it, and afterwards it is the
  // shop's evidence of what the distributor actually sent.
  const id = randomUUID();
  const ext = looksLikePdf(buf) ? '.pdf' : '.png';
  writeFileSync(join(scansDir(), id + ext), buf);
  pruneAbandonedScans();

  const db = getDb();
  const products = db.prepare(
    'SELECT id, name, pack_size, gst_rate FROM products WHERE active = 1',
  ).all() as Array<Pick<Product, 'id' | 'name' | 'pack_size' | 'gst_rate'>>;

  const lines: ReviewLine[] = invoice.lines.map((line) => {
    const hit = matchProduct(line.product_name, products);
    const product = hit ? products.find((p) => p.id === hit.product_id) : undefined;
    return {
      ...line,
      product_id: hit?.product_id ?? null,
      matched_name: product?.name ?? '',
      match: hit?.confidence ?? 'none',
      // Fall back to what the shop already knows about a matched product; the
      // distributor's own columns are often blank for these.
      pack_size: line.pack_size ?? product?.pack_size ?? null,
      gst_rate: line.gst_rate ?? product?.gst_rate ?? null,
    };
  });

  // Suggest the supplier by GSTIN first — it is unambiguous where a name is not.
  const suppliers = db.prepare('SELECT id, name, gstin FROM suppliers WHERE active = 1')
    .all() as Array<{ id: number; name: string; gstin: string }>;
  const byGstin = invoice.supplier_gstin
    ? suppliers.find((s) => s.gstin.toUpperCase() === invoice.supplier_gstin)
    : undefined;
  const supplier = byGstin
    ?? suppliers.find((s) => squash(s.name).length > 3
      && squash(invoice.supplier_name).includes(squash(s.name)));

  res.json({
    scan_id: id,
    source: read.source,
    attempt: read.attempt,
    confidence: Math.round(invoice.confidence),
    took_ms: Date.now() - started,
    supplier_id: supplier?.id ?? null,
    supplier_name: invoice.supplier_name,
    supplier_gstin: invoice.supplier_gstin,
    invoice_no: invoice.invoice_no,
    invoice_date: invoice.invoice_date,
    lines,
    skipped: invoice.skipped,
  });
});

/** The stored original, so the review screen can show it beside the figures. */
invoiceScanRouter.get('/:id/file', (req, res) => {
  const id = String(req.params.id);
  // The id goes into a filesystem path, so nothing but a plain UUID may pass.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: 'Not a scan reference' });
    return;
  }
  for (const ext of ['.png', '.pdf']) {
    const path = join(scansDir(), id + ext);
    if (existsSync(path)) {
      res.type(ext === '.pdf' ? 'application/pdf' : 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(readFileSync(path));
      return;
    }
  }
  res.status(404).json({ error: 'That scan is no longer on file' });
});
