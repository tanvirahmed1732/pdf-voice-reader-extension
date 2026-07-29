// Copies the PDF.js ESM builds out of node_modules into vendor/pdfjs.
// Run after `npm install` or after upgrading pdfjs-dist: `npm run vendor:pdfjs`
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist', 'build');
const dest = join(root, 'vendor', 'pdfjs');

await mkdir(dest, { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  await copyFile(join(src, file), join(dest, file));
  console.log(`vendored ${file}`);
}
