// Generates test/test.pdf — a small two-page PDF with real text — used by
// the e2e smoke test. Offsets in the xref table are computed programmatically.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function contentStream(lines) {
  const ops = lines
    .map((line, i) => `BT /F1 14 Tf 72 ${700 - i * 24} Td (${line}) Tj ET`)
    .join('\n');
  return ops;
}

const page1 = contentStream([
  'Hello world. This is the first test sentence.',
  'The quick brown fox jumps over the lazy dog.',
  'Reading aloud should highlight every word as it is spoken.',
]);
const page2 = contentStream([
  'This is page two of the test document.',
  'Playback should continue here without stopping.',
]);

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
  `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
  `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

await mkdir(join(root, 'test'), { recursive: true });
await writeFile(join(root, 'test', 'test.pdf'), pdf, 'latin1');
console.log('wrote test/test.pdf');
