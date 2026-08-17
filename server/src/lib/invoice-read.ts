/**
 * Getting words and their positions out of whatever the shop hands us.
 *
 * Three kinds of file arrive, and they deserve very different treatment:
 *
 *   A PDF from the distributor's own billing software carries a text layer.
 *   Reading it is exact — every character and coordinate is already there, so
 *   OCR would only introduce errors into a perfect source.
 *
 *   A scan or a straight, well-lit photograph needs OCR, and benefits enormously
 *   from having its contrast stretched first. On a test photograph the raw file
 *   yielded no recognisable table at all and the same file, greyscaled and
 *   normalised, yielded one.
 *
 *   A casual snapshot at an angle, small in frame, is not readable. Measured,
 *   not assumed: such a file produced a header row and no usable line beneath
 *   it. The honest response is to say the picture is not good enough and ask for
 *   another, because a plausible-looking wrong batch number is far worse for a
 *   pharmacy than a clear refusal.
 */
import sharp, { type Sharp } from 'sharp';
import { readImage } from './ocr.js';
import { groupIntoRows, findColumns, type OcrWord } from './invoice-parse.js';

export type ReadSource = 'pdf-text' | 'ocr';

export type ReadResult = {
  words: OcrWord[];
  source: ReadSource;
  confidence: number;
  /** Empty when the file read well enough to attempt parsing. */
  problem: string;
  /** How the image was prepared, for the log and for support questions. */
  attempt: string;
};

const PDF_MAGIC = Buffer.from('%PDF');

export function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 4).equals(PDF_MAGIC);
}

// ---------------------------------------------------------------------------
// PDFs with a text layer
// ---------------------------------------------------------------------------

/**
 * Read a digital PDF's own text, with positions.
 *
 * Returns an empty list for a PDF that is merely a wrapper around a scanned
 * image — there is no text layer to read, and the caller falls back to OCR.
 */
export async function readPdfText(buf: Buffer): Promise<OcrWord[]> {
  // pdfjs is an ESM build with a browser-shaped entry point; the legacy build
  // is the one meant for Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Nothing here should ever reach the network or execute embedded script.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  const words: OcrWord[] = [];
  // A goods-inward invoice runs to a page or three; beyond that something else
  // has been uploaded and reading all of it would only waste the shop's time.
  const pages = Math.min(doc.numPages, 5);
  let pageOffset = 0;

  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    for (const item of content.items as Array<{
      str: string; transform: number[]; width: number; height: number;
    }>) {
      const text = item.str.trim();
      if (!text) continue;
      const x = item.transform[4];
      // PDF measures upward from the bottom of the page; screens and OCR
      // measure downward from the top.
      const y = viewport.height - item.transform[5];
      const height = item.height || 10;

      // A text item can hold several words. Splitting them keeps the column
      // assignment honest, and the width is apportioned by character count —
      // exact glyph metrics are not needed to decide which column a word is in.
      const parts = text.split(/\s+/).filter(Boolean);
      const perChar = item.width / Math.max(text.length, 1);
      let cursor = x;
      for (const part of parts) {
        const w = part.length * perChar;
        words.push({
          text: part,
          x0: cursor, x1: cursor + w,
          y0: y - height + pageOffset, y1: y + pageOffset,
          confidence: 100,
        });
        cursor += w + perChar;
      }
    }
    // Stack pages vertically so a two-page invoice reads as one long table.
    pageOffset += viewport.height + 40;
  }

  await doc.destroy();
  return words;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Preparations to try, best-understood first. */
const RENDITIONS: Array<{ name: string; build: (b: Buffer) => Sharp }> = [
  {
    name: 'contrast-stretched',
    build: (b) => sharp(b).greyscale().normalise().sharpen({ sigma: 1 }),
  },
  {
    name: 'as-supplied',
    build: (b) => sharp(b),
  },
  {
    // A page laid on a counter is rarely square to the camera. Small rotations
    // are cheap to try and sometimes make the difference.
    name: 'deskewed-left',
    build: (b) => sharp(b).rotate(-1.5, { background: '#ffffff' })
      .greyscale().normalise().sharpen({ sigma: 1 }),
  },
  {
    name: 'deskewed-right',
    build: (b) => sharp(b).rotate(1.5, { background: '#ffffff' })
      .greyscale().normalise().sharpen({ sigma: 1 }),
  },
];

/**
 * OCR an image, trying a few preparations and keeping whichever reads best.
 *
 * "Best" means a recognisable table first and word count second: a rendition
 * that finds the column headers is worth more than one that reads more words
 * out of the shop's letterhead.
 */
export async function readImageBest(buf: Buffer): Promise<ReadResult> {
  let best: ReadResult | null = null;
  let bestScore = -1;

  for (const rendition of RENDITIONS) {
    let prepared: Buffer;
    try {
      prepared = await rendition.build(buf).png().toBuffer();
    } catch {
      continue; // not a decodable image in this rendition; try the next
    }

    const { words, confidence } = await readImage(prepared);
    const hasTable = findColumns(groupIntoRows(words)) !== null;
    const score = (hasTable ? 10_000 : 0) + words.length;

    if (score > bestScore) {
      bestScore = score;
      best = {
        words, confidence, source: 'ocr', problem: '', attempt: rendition.name,
      };
    }
    // A rendition that found the table is good enough; the rest are only there
    // for when it does not, and each costs a second of the shop's time.
    if (hasTable) break;
  }

  if (!best) {
    return {
      words: [], source: 'ocr', confidence: 0, attempt: 'none',
      problem: 'That file could not be opened as an image or a PDF.',
    };
  }
  return best;
}

/**
 * Read an uploaded invoice, whatever form it takes.
 *
 * `problem` is set — and it is written for a shopkeeper, not a programmer —
 * whenever the file is too poor to go on with.
 */
export async function readInvoice(buf: Buffer): Promise<ReadResult> {
  if (looksLikePdf(buf)) {
    let words: OcrWord[] = [];
    try {
      words = await readPdfText(buf);
    } catch {
      words = [];
    }
    if (words.length > 20) {
      return { words, source: 'pdf-text', confidence: 100, problem: '', attempt: 'pdf text layer' };
    }
    // A PDF that is only a photograph in a wrapper has no text to read, and
    // rendering its pages would need a graphics stack this does not carry.
    return {
      words: [], source: 'pdf-text', confidence: 0, attempt: 'pdf text layer',
      problem: 'This PDF holds a scanned picture rather than text. '
        + 'Save or export the invoice as a PDF from your distributor\'s software, '
        + 'or photograph the printed page and upload that instead.',
    };
  }

  const result = await readImageBest(buf);
  if (result.words.length === 0) return result;

  // Fewer words than this is not an invoice that was read badly; it is a
  // picture nothing could be read from.
  if (result.words.length < 25) {
    return {
      ...result,
      problem: 'Very little text could be read from that picture. '
        + 'Lay the invoice flat, fill the frame with it, and take the photo straight on in good light.',
    };
  }

  if (findColumns(groupIntoRows(result.words)) === null) {
    return {
      ...result,
      problem: 'The columns of the invoice could not be made out. '
        + 'This usually means the photo is at an angle or slightly out of focus — '
        + 'a flat, straight-on picture, or a scan, reads far better.',
    };
  }

  return result;
}
