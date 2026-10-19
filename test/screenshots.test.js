import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScreenshotStore } from '../screenshots.js';

test('saves timestamped PNGs in the default directory without overwriting', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-screenshots-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new ScreenshotStore(root, path.join(root, 'config'));
  assert.equal(await store.load(), path.join(root, 'Pictures', 'Screenshots'));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const frame = { dataUrl: `data:image/png;base64,${png.toString('base64')}`, capturedAt: Date.parse('2026-10-18T13:55:55.405Z') };
  const first = await store.save(frame);
  const second = await store.save(frame);
  assert.equal(path.basename(first), 'Screenshot-2026-10-18T13-55-55-405Z.png');
  assert.equal(path.basename(second), 'Screenshot-2026-10-18T13-55-55-405Z-1.png');
  assert.deepEqual(await readFile(first), png);
  assert.deepEqual(await readFile(second), png);
});

test('remembers directory selection and surfaces invalid settings and write failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-screenshots-'));
  t.after(() => rm(root, { recursive: true }));
  const config = path.join(root, 'config');
  const store = new ScreenshotStore(root, config);
  const directory = path.join(root, 'chosen folder');
  await store.select(directory);
  assert.equal(await new ScreenshotStore(root, config).load(), directory);
  await assert.rejects(store.select('relative'), /absolute/);
  await assert.rejects(store.save(null), /No screenshot/);
  await writeFile(store.settingsPath, '{bad json');
  await assert.rejects(store.load(), SyntaxError);
  await writeFile(store.settingsPath, '{"directory":"relative"}');
  await assert.rejects(store.load(), /Invalid saved/);
  await mkdir(directory);
  const blocker = path.join(directory, 'file');
  await writeFile(blocker, 'not a directory');
  await store.select(blocker);
  await assert.rejects(store.save({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', capturedAt: 0 }), { code: 'EEXIST' });
});
