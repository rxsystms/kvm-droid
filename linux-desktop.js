import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const desktopName = 'kvm-droid.desktop';

export function desktopEntry(executable, args, iconPath) {
  const quote = (value) => {
    if (/[\r\n\0]/.test(value)) throw new Error('Desktop launcher paths must not contain newlines or NUL.');
    // Desktop entries have a string-escape layer in addition to Exec argument quoting.
    return `"${value.replaceAll('\\', '\\\\\\\\').replaceAll('"', '\\\\"')
      .replaceAll('`', '\\\\`').replaceAll('$', '\\\\$').replaceAll('%', '%%')}"`;
  };
  if (/[\r\n\0]/.test(iconPath)) throw new Error('Invalid desktop icon path.');
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=kvm-droid',
    'Comment=Control a remote Android device over SSH',
    `Exec=${[executable, ...args].map(quote).join(' ')}`,
    `Icon=${iconPath.replaceAll('\\', '\\\\')}`, 'Terminal=false',
    'Categories=Utility;', 'StartupWMClass=kvm-droid', '',
  ].join('\n');
}

export async function installLinuxDesktop({ executable, args, iconPath, dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share') }) {
  if (!path.isAbsolute(dataHome)) throw new Error('XDG_DATA_HOME must be an absolute path.');
  const applications = path.join(dataHome, 'applications');
  const icons = path.join(dataHome, 'icons', 'hicolor', '1024x1024', 'apps');
  const installedIcon = path.join(icons, 'kvm-droid.png');
  const entry = desktopEntry(executable, args, installedIcon);
  await Promise.all([mkdir(applications, { recursive: true }), mkdir(icons, { recursive: true })]);
  await copyFile(iconPath, installedIcon);
  await writeFile(path.join(applications, desktopName), entry, { mode: 0o644 });
}
