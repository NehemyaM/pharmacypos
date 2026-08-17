/**
 * Put the OCR language data where the built server can find it.
 *
 * tesseract.js downloads this from a CDN on first use if it is not on disk,
 * which is exactly wrong for a shop counter: the machine may have no internet
 * at all, and the failure would appear only when someone tried to read an
 * invoice. Shipping the file removes the question.
 */
import { copyFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist', 'tessdata');
mkdirSync(out, { recursive: true });

const candidates = [
  join(here, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0', 'eng.traineddata.gz'),
  join(here, '..', '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0', 'eng.traineddata.gz'),
];

const source = candidates.find((p) => existsSync(p));
if (!source) {
  console.error('OCR language data not found. Reading invoices will not work offline.');
  console.error('Looked in:\n  ' + candidates.join('\n  '));
  process.exit(1);
}

copyFileSync(source, join(out, 'eng.traineddata.gz'));
console.log('tessdata: eng.traineddata.gz ->', out);

// Older builds let the OCR engine decompress its training data in place, which
// leaves a 23MB copy of what the 10MB archive already holds. The engine now
// unpacks into the application's own data directory instead, so any such file
// here is stale and would only pad the installer.
const stale = join(out, 'eng.traineddata');
if (existsSync(stale)) {
  rmSync(stale);
  console.log('tessdata: removed a stale decompressed copy');
}

/*
 * Declare the compiled output as ES modules.
 *
 * The server is ESM, which `server/package.json` states — but the desktop build
 * copies only `dist/` into the installed application, leaving the compiled
 * files with no package.json above them. Node then reads them as CommonJS and
 * the very first `import` throws "Cannot use import statement outside a
 * module", the server dies, the shell restarts it, and the shop gets an
 * application that never opens a window.
 */
const dist = join(here, '..', 'dist');
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
console.log('dist/package.json: { "type": "module" }');
