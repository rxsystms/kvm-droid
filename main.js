import { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AndroidDevice } from './transport.js';
import { desktopName, installLinuxDesktop } from './linux-desktop.js';
import { ScreenshotStore } from './screenshots.js';
import { recognizeScreen } from './ocr.js';

// Keep the existing profile so the product rename preserves saved settings.
if (app.getPath('userData') === path.join(app.getPath('appData'), app.getName())) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Android Remote'));
}
app.setName('kvm-droid');
if (process.platform === 'linux') {
  app.setDesktopName(desktopName);
  app.commandLine.appendSwitch('class', 'kvm-droid');
}

const pageUrl = new URL('./index.html', import.meta.url).href;
const device = new AndroidDevice(undefined, async (connection) => {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Switch SELinux to permissive?',
    message: `Reduce SELinux protection on ${connection.username}@${connection.host}?`,
    detail: 'Permissive mode stops SELinux from enforcing access controls across the device. Only use it for troubleshooting. Press S again to restore Enforcing. Closing this app does not restore the setting.',
    buttons: ['Cancel', 'Switch to permissive'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
});
let window;
let screenshots;
let latestFrame = null;
let ocrBusy = false;

function createWindow() {
  window = new BrowserWindow({
    width: 750,
    height: 1000,
    minWidth: 680,
    minHeight: 580,
    backgroundColor: '#11151c',
    title: 'kvm-droid',
    icon: fileURLToPath(new URL('./resources/icon.png', import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadURL(pageUrl).catch((error) => {
    dialog.showErrorBox('Cannot open kvm-droid', error.message);
    app.quit();
  });
}

ipcMain.handle('device:request', async (event, message) => {
  if (!window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
    throw new Error('Device requests are only allowed from the app window.');
  }
  try {
    if (message.type === 'connect') latestFrame = null;
    const frame = await device.request(message);
    if (message.type === 'disconnect') latestFrame = null;
    else if (frame.dataUrl) latestFrame = frame;
    return { ok: true, frame };
  } catch (error) {
    console.error('Device request failed:', error.message);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('screenshots:request', async (event, action) => {
  if (!window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
    throw new Error('Screenshot requests are only allowed from the app window.');
  }
  try {
    if (action === 'directory') return { ok: true, directory: await screenshots.load() };
    if (action === 'choose') {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose screenshot directory',
        defaultPath: screenshots.directory,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled) return { ok: true, cancelled: true };
      return { ok: true, directory: await screenshots.select(result.filePaths[0]) };
    }
    if (action === 'save') return { ok: true, path: await screenshots.save(latestFrame) };
    if (action === 'ocr') {
      if (ocrBusy) throw new Error('OCR is already running.');
      ocrBusy = true;
      try {
        return { ok: true, text: await recognizeScreen(latestFrame) };
      } finally {
        ocrBusy = false;
      }
    }
    throw new Error('Unknown screenshot action.');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Screenshot request failed:', detail);
    return { ok: false, error: detail };
  }
});

app.whenReady().then(async () => {
  screenshots = new ScreenshotStore(app.getPath('home'), app.getPath('userData'));
  if (process.platform === 'linux') {
    await installLinuxDesktop({
      executable: process.env.APPIMAGE || process.execPath,
      args: app.isPackaged ? [] : [fileURLToPath(new URL('.', import.meta.url))],
      iconPath: fileURLToPath(new URL('./resources/icon.png', import.meta.url)),
    });
  }
  if (process.platform === 'darwin') {
    app.dock.setIcon(nativeImage.createFromPath(fileURLToPath(new URL('./resources/icon.png', import.meta.url))));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox('kvm-droid failed to start', error.message);
  app.quit();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
