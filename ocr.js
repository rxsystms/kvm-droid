import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const unpacked = (filename) => filename.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

export async function recognizeScreen(frame) {
  if (!frame?.dataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error('No screenshot available. Connect and refresh first.');
  }
  const worker = await createWorker('eng', 1, {
    workerPath: unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js')),
    corePath: unpacked(path.dirname(require.resolve('tesseract.js-core/tesseract-core.wasm.js'))),
    langPath: unpacked(require('@tesseract.js-data/eng').langPath),
    gzip: true,
    cacheMethod: 'none',
    errorHandler: (error) => console.error('OCR worker failed:', error),
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const { data } = await worker.recognize(Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    return data.text;
  } finally {
    await worker.terminate();
  }
}
