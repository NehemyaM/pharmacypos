/**
 * Reading an invoice photograph.
 *
 * Runs entirely on the shop's own machine. The recogniser is WASM and the
 * English training data is an npm dependency copied in at build time, so no part
 * of this reaches the network and no page of the shop's purchase book is sent to
 * anyone. That is not only a privacy position: the counter is expected to keep
 * working through a Hyderabad power cut with the router down, and a feature that
 * silently needs the internet is a feature that fails on the worst day.
 */
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrWord } from './invoice-parse.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the training data lives.
 *
 * Checked in order: an explicit override, the copy placed beside the compiled
 * output by the build, then the npm package itself for development. If none
 * exists the worker would silently try to download it, so we would rather fail
 * loudly here than have the shop discover it offline.
 */
export function langPath(): string {
  const candidates = [
    process.env.PHARMACY_TESSDATA,
    join(here, '..', 'tessdata'),
    join(here, '..', '..', 'tessdata'),
    join(here, '..', '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
    join(here, '..', '..', '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'eng.traineddata.gz')) || existsSync(join(dir, 'eng.traineddata'))) {
      return dir;
    }
  }
  throw new Error(
    'OCR language data is missing. It ships in @tesseract.js-data/eng; run npm install, '
    + 'or point PHARMACY_TESSDATA at a directory containing eng.traineddata.gz.',
  );
}

let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;

/**
 * One long-lived worker.
 *
 * Starting it costs the better part of a second and it is perfectly reusable,
 * so a shop entering a stack of invoices pays that once rather than per page.
 */
async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  if (starting) return starting;

  starting = (async () => {
    const dir = langPath();
    mkdirSync(dir, { recursive: true });
    const w = await createWorker('eng', 1, {
      langPath: dir,
      cachePath: dir,
      gzip: true,
      // Silence the progress chatter; it is not useful in a server log.
      logger: () => undefined,
    });
    await w.setParameters({
      // Single column of variable-sized text. The automatic mode reads a
      // bordered table's separators as characters and interleaves the columns;
      // this one keeps the words and their boxes intact, which is all we need
      // because the layout is rebuilt from the geometry anyway.
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
    });
    worker = w;
    return w;
  })();

  return starting;
}

/** Release the worker. Used by tests and on shutdown. */
export async function stopOcr(): Promise<void> {
  const w = worker;
  worker = null;
  starting = null;
  if (w) await w.terminate();
}

export type OcrResult = {
  words: OcrWord[];
  /** Mean confidence over the page, 0-100. */
  confidence: number;
  /** Milliseconds spent recognising. */
  took_ms: number;
};

/** Recognise an image buffer, returning every word with its bounding box. */
export async function readImage(image: Buffer): Promise<OcrResult> {
  const w = await getWorker();
  const started = Date.now();
  const { data } = await w.recognize(image, {}, { blocks: true, text: false });

  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          if (!word.text.trim()) continue;
          words.push({
            text: word.text.trim(),
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
            confidence: word.confidence,
          });
        }
      }
    }
  }

  return {
    words,
    confidence: words.length
      ? words.reduce((s, x) => s + x.confidence, 0) / words.length
      : 0,
    took_ms: Date.now() - started,
  };
}
