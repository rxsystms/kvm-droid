import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopEntry, installLinuxDesktop } from '../linux-desktop.js';

test('desktop entry quotes launcher arguments and matches the Linux window identity', () => {
  const entry = desktopEntry('/opt/Android Remote/app', ['/work/remote app'], '/icons/app.png');
  assert.match(entry, /Exec="\/opt\/Android Remote\/app" "\/work\/remote app"/);
  assert.match(entry, /StartupWMClass=kvm-droid/);
  assert.match(entry, /^Name=kvm-droid$/m);
  assert.match(entry, /Icon=\/icons\/app.png/);
  assert.ok(desktopEntry('/app%name', [], '/icon').includes('/app%%name'));
  assert.throws(() => desktopEntry('/app\nExec=bad', [], '/icon'));
});

test('desktop registration persists the launcher and independent icon in XDG data home', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-remote-desktop-test-'));
  try {
    const source = path.join(root, 'source.png');
    await writeFile(source, 'test-icon');
    await installLinuxDesktop({ executable: '/app', args: [], iconPath: source, dataHome: root });
    const icon = path.join(root, 'icons/hicolor/1024x1024/apps/kvm-droid.png');
    assert.equal(await readFile(icon, 'utf8'), 'test-icon');
    assert.equal(await readFile(path.join(root, 'applications/kvm-droid.desktop'), 'utf8'),
      desktopEntry('/app', [], icon));
    await assert.rejects(installLinuxDesktop({ executable: '/app', args: [], iconPath: source, dataHome: 'relative' }), /absolute/);
  } finally {
    await rm(root, { recursive: true });
  }
});
