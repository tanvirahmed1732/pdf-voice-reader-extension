// Generates test/prose.pdf — several pages of ordinary prose (the realistic
// case, unlike the math/code-heavy arXiv paper) to check playback smoothness.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SENTENCES = [
  'John Carlton is a famous and successful businessman today.',
  'He writes special messages called advertisements that help people sell things.',
  'He is so good at it that people pay him thousands of dollars just to talk to him.',
  'But he was not always successful, and in fact he started out with almost nothing.',
  'When John was thirty years old, he hit rock bottom in just two months.',
  'He lost his job, his relationship, and the place where he used to live.',
  'He had to sleep on the couches of his friends and he had very little money.',
  'One day he woke up and realized a simple but powerful truth about his life.',
  'Nobody was coming to rescue him, so he would have to make it happen himself.',
  'He decided to start his own business as a freelance writer for other companies.',
  'His friends and family thought he was crazy because he knew nothing about business.',
  'Every morning he would drive to the public library and read everything he could.',
  'He studied the old masters of persuasion and copied their letters by hand.',
  'Slowly, and with a great deal of practice, his writing began to improve.',
  'The first client he landed paid him only a small amount for a great deal of work.',
  'But that first success gave him the confidence to keep going and to charge more.',
  'Within a few years he had built a reputation as one of the best in the industry.',
  'Today he shares the lessons he learned so that others can avoid the same mistakes.',
];

function contentStream(lines) {
  return lines.map((line, i) => `BT /F1 13 Tf 64 ${720 - i * 30} Td (${line}) Tj ET`).join('\n');
}

// 4 pages, each with all sentences → plenty of sentences to read.
const pages = [0, 1, 2, 3].map(() => contentStream(SENTENCES));

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Dummy 0 >>',
];
pages.forEach((body, i) => {
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${9 + i} 0 R >>`,
  );
});
pages.forEach((body) => {
  objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
});

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

await writeFile(join(root, 'test', 'prose.pdf'), pdf, 'latin1');
console.log('wrote test/prose.pdf');
