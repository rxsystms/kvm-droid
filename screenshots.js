import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ScreenshotStore {
  constructor(home, userData) {
    this.directory = path.join(home, 'Pictures', 'Screenshots');
    this.settingsPath = path.join(userData, 'screenshots.json');
  }

  async load() {
    let contents;
    try {
      contents = await readFile(this.settingsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this.directory;
      throw error;
    }
    const { directory } = JSON.parse(contents);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new Error('Invalid saved screenshot directory.');
    }
    this.directory = directory;
    return directory;
  }

  async select(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new Error('Screenshot directory must be an absolute path.');
    }
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify({ directory }), { mode: 0o600 });
    this.directory = directory;
    return directory;
  }

  async save(frame) {
    if (!frame?.dataUrl?.startsWith('data:image/png;base64,') ||
        !Number.isFinite(frame.capturedAt)) {
      throw new Error('No screenshot available. Connect and refresh first.');
    }
    const png = Buffer.from(frame.dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const timestamp = new Date(frame.capturedAt).toISOString().replace(/[:.]/g, '-');
    await mkdir(this.directory, { recursive: true });
    for (let suffix = 0; ; suffix++) {
      const filename = path.join(this.directory, `Screenshot-${timestamp}${suffix ? `-${suffix}` : ''}.png`);
      try {
        await writeFile(filename, png, { flag: 'wx', mode: 0o600 });
        return filename;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }
}
