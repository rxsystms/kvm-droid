import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { recognizeScreen } from '../ocr.js';

test('offline OCR recognizes English using bundled data', async () => {
  const svg = Buffer.from('<svg width="1000" height="200"><rect width="100%" height="100%" fill="white"/><text x="30" y="120" font-family="sans-serif" font-size="64" fill="black">HELLO OFFLINE 12345</text></svg>');
  const png = await sharp(svg).png().toBuffer();
  const text = await recognizeScreen({ dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.match(text, /HELLO OFFLINE 12345/);
});

test('OCR explicitly rejects missing screenshots and returns empty text for blank images', async () => {
  await assert.rejects(recognizeScreen(null), /No screenshot/);
  const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  assert.equal((await recognizeScreen({ dataUrl: `data:image/png;base64,${png.toString('base64')}` })).trim(), '');
});
