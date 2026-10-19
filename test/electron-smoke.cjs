const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const smokeHost = process.env.KVM_DROID_HOST?.trim();
const smokeUsername = process.env.KVM_DROID_USERNAME?.trim();
let desktopData;
let screenshotData;

if (!smokeHost || !smokeUsername) {
  throw new Error('Set KVM_DROID_HOST and KVM_DROID_USERNAME to your saved connection values before running the smoke test.');
}

async function waitFor(window, expression, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

app.whenReady().then(async () => {
  screenshotData = await mkdtemp(path.join(os.tmpdir(), 'android-remote-screenshots-'));
  app.setPath('userData', path.join(screenshotData, 'config'));
  if (process.platform === 'linux') {
    desktopData = await mkdtemp(path.join(os.tmpdir(), 'android-remote-desktop-'));
    process.env.XDG_DATA_HOME = desktopData;
  }
  const mainUrl = process.env.REMOTE_APP_PATH ?
    require('node:url').pathToFileURL(path.join(process.env.REMOTE_APP_PATH, 'main.js')).href :
    require('node:url').pathToFileURL(path.join(__dirname, '..', 'main.js')).href;
  await import(mainUrl);
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (BrowserWindow.getAllWindows().length) resolve();
      else if (Date.now() > deadline) reject(new Error('App window did not open'));
      else setTimeout(check, 50);
    };
    check();
  });
  const window = BrowserWindow.getAllWindows()[0];
  assert.ok(window, 'app window created');
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  await waitFor(window, "document.readyState === 'complete'");
  assert.equal(app.getName(), 'kvm-droid');
  assert.equal(await window.webContents.executeJavaScript('document.title'), 'kvm-droid');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('h1').textContent"), 'kvm-droid');
  assert.equal(await window.webContents.executeJavaScript('typeof window.android.request'), 'function');
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('refresh').disabled"), true);
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
  console.log('PASS: Electron startup, sandbox, preload bridge and initial UI');
  await waitFor(window, "document.getElementById('app-logo').complete && document.getElementById('app-logo').naturalWidth > 0");
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('app-logo')).backgroundColor"), 'rgb(233, 213, 255)');
  const { nativeImage } = require('electron');
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'icon.png'));
  assert.equal(icon.isEmpty(), false);
  assert.deepEqual(icon.getSize(), { width: 1024, height: 1024 });
  console.log('PASS: supplied app logo, light-purple background and native app icon');

  await waitFor(window, "!document.getElementById('screenshot-directory').disabled");
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('save-screenshot').disabled"), true);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('phone-text').disabled && document.getElementById('send-text').disabled"), true);
  const originalPicker = dialog.showOpenDialog;
  const { AndroidDevice } = await import(new URL('./transport.js', mainUrl));
  const originalRequest = AndroidDevice.prototype.request;
  const inputActions = [];
  const png = nativeImage.createFromBuffer(await readFile(path.join(__dirname, '..', 'resources', 'icon.png'))).toPNG();
  try {
    dialog.showOpenDialog = async (_window, options) => {
      assert.ok(options.properties.includes('openDirectory'));
      return { canceled: false, filePaths: [path.join(screenshotData, 'chosen')] };
    };
    await window.webContents.executeJavaScript("document.getElementById('screenshot-directory').click()");
    await waitFor(window, "document.getElementById('screenshot-path').textContent.endsWith('chosen') && !document.getElementById('connect').disabled");
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    await window.webContents.executeJavaScript("document.getElementById('screenshot-directory').click()");
    await waitFor(window, "!document.getElementById('connect').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('screenshot-path').textContent.endsWith('chosen')"), true);
    AndroidDevice.prototype.request = async (message) => {
      if (message.type === 'input') inputActions.push(message.action);
      return message.type === 'disconnect' ? {} : ({
      width: 1024, height: 1024, capturedAt: 0,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      deviceInfo: { screenSize: { physical: { width: 1024, height: 1024 } }, selinux: 'Enforcing' },
      });
    };
    const connection = JSON.stringify({ host: smokeHost, username: smokeUsername });
    await window.webContents.executeJavaScript(`(() => {
      const connection = ${connection};
      for (const [id, value] of Object.entries(connection)) {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('auto-refresh').checked = false;
      document.getElementById('connect').click();
    })()`);
    assert.deepEqual(JSON.parse(await window.webContents.executeJavaScript(`JSON.stringify({
      host: localStorage.getItem('kvm-droid.host'),
      username: localStorage.getItem('kvm-droid.username'),
    })`)), connection, 'connection fields are remembered');
    await waitFor(window, "!document.getElementById('save-screenshot').disabled");
    await window.webContents.executeJavaScript("document.getElementById('ocr-screen').click()");
    await waitFor(window, "document.getElementById('status').textContent === 'Offline OCR complete.' && !document.getElementById('ocr-screen').disabled", 60000);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('ocr-text').readOnly && document.getElementById('ocr-screen').closest('aside').id === 'screen-controls'"), true);
    console.log('PASS: bundled offline OCR completes via preload IPC and displays a selectable result');
    await window.webContents.executeJavaScript(`(() => {
      const text = document.getElementById('phone-text');
      text.value = 'Hello world! 100%';
      text.dispatchEvent(new Event('input'));
      text.focus();
      for (const code of ['Space', 'KeyS']) {
        text.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
      }
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await waitFor(window, "!document.getElementById('phone-text').disabled && document.getElementById('phone-text').value === ''");
    assert.deepEqual(inputActions, [{ type: 'text', text: 'Hello world! 100%' }], 'typing does not trigger Space/S shortcuts');
    for (const key of ['ENTER', 'DEL']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-key="${key}"]').click()`);
      await waitFor(window, "!document.getElementById('phone-text').disabled");
    }
    assert.deepEqual(inputActions.slice(1), [{ type: 'key', key: 'ENTER' }, { type: 'key', key: 'DEL' }]);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('phone-text').closest('aside').id"), 'device-controls');
    console.log('PASS: right-side text input, Send via Enter, shortcut isolation, Enter and Backspace');
    const originalBounds = window.getBounds();
    for (const [width, height] of [[700, 900], [680, 580], [1200, 700]]) {
      window.setSize(width, height);
      await waitFor(window, `(() => {
        const left = document.getElementById('screen-controls').getBoundingClientRect();
        const stage = document.getElementById('screen-stage').getBoundingClientRect();
        const right = document.getElementById('device-controls').getBoundingClientRect();
        const viewer = document.getElementById('viewer').getBoundingClientRect();
        const leftIds = ['selinux', 'device-info', 'refresh', 'auto-refresh',
          'save-screenshot', 'screenshot-directory', 'screenshot-path'];
        return leftIds.every(id => document.getElementById(id).closest('aside').id === 'screen-controls') &&
          [...document.querySelectorAll('[data-key], #pull-down-menu')].every(
            element => element.closest('aside').id === 'device-controls') &&
          left.left >= 0 && left.right <= stage.left && stage.right <= right.left &&
          right.right <= innerWidth && stage.width > 0 &&
          viewer.width > 0 && viewer.height > 0 &&
          viewer.left >= stage.left - 1 && viewer.right <= stage.right + 1 &&
          viewer.top >= stage.top - 1 && viewer.bottom <= stage.bottom + 1 &&
          Math.abs(viewer.width / viewer.height - 1) < 0.001;
      })()`);
    }
    window.setBounds(originalBounds);
    console.log('PASS: screen controls stay left, hardware controls right, and screenshot fits at minimum/default/wide sizes');
    await window.webContents.executeJavaScript("document.getElementById('save-screenshot').click()");
    await waitFor(window, "document.getElementById('status').textContent.startsWith('Screenshot saved:') && !document.getElementById('connect').disabled");
    assert.deepEqual(await readFile(path.join(screenshotData, 'chosen', 'Screenshot-1970-01-01T00-00-00-000Z.png')), png);
    await window.webContents.executeJavaScript("document.getElementById('connect').click()");
    await waitFor(window, "document.getElementById('connect').textContent === 'Connect' && !document.getElementById('connect').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('save-screenshot').disabled"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('phone-text').disabled && document.getElementById('send-text').disabled"), true);
    await window.webContents.executeJavaScript("document.getElementById('auto-refresh').checked = true");
    console.log('PASS: screenshot folder picker, cancellation, save displayed PNG and disconnect state');
  } finally {
    dialog.showOpenDialog = originalPicker;
    AndroidDevice.prototype.request = originalRequest;
  }

  if (process.env.REMOTE_SMOKE === '1') {
    await window.webContents.executeJavaScript("document.getElementById('connect').click()");
    await waitFor(window, "!document.getElementById('screen').hidden && document.getElementById('viewer').getAttribute('aria-busy') === 'false'");
    const dimensions = await window.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('screen');
      const rect = image.getBoundingClientRect();
      return { width: image.naturalWidth, height: image.naturalHeight,
        ratio: rect.width / rect.height, refreshEnabled: !document.getElementById('refresh').disabled };
    })()`);
    assert.ok(dimensions.width > 0 && dimensions.height > 0);
    assert.ok(Math.abs(dimensions.ratio - dimensions.width / dimensions.height) < 0.01);
    assert.ok(dimensions.refreshEnabled);
    console.log(`PASS: real SSH screenshot rendered at ${dimensions.width}x${dimensions.height}, correct display aspect ratio`);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('connect').textContent"), 'Disconnect');
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('connect').classList.contains('disconnect')"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('host').disabled && document.getElementById('username').disabled"), true);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('screen');
      const rect = image.getBoundingClientRect();
      image.dispatchEvent(new PointerEvent('pointermove', {
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
      return document.getElementById('pointer-coordinates').textContent ===
        'X: ' + Math.floor(image.naturalWidth / 2) + ' / Y: ' + Math.floor(image.naturalHeight / 2);
    })()`), true, 'pointer readout maps to phone pixels');
    await window.webContents.executeJavaScript("document.getElementById('screen').dispatchEvent(new PointerEvent('pointerleave'))");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('pointer-coordinates').textContent"), 'X: -- / Y: --');

    const originalBounds = window.getBounds();
    for (const [width, height] of [[1000, 900], [680, 580], [1200, 700]]) {
      window.setSize(width, height);
      await waitFor(window, `(() => {
        const viewer = document.getElementById('viewer').getBoundingClientRect();
        const stage = document.getElementById('screen-stage').getBoundingClientRect();
        const image = document.getElementById('screen');
        return viewer.width > 0 && viewer.height > 0 &&
          Math.abs(viewer.width / viewer.height - image.naturalWidth / image.naturalHeight) < 0.001 &&
          viewer.left >= stage.left - 1 && viewer.right <= stage.right + 1 &&
          viewer.top >= stage.top - 1 && viewer.bottom <= stage.bottom + 1 &&
          (Math.abs(viewer.width - stage.width) < 1 || Math.abs(viewer.height - stage.height) < 1);
      })()`);
      assert.equal(await window.webContents.executeJavaScript(`(() => {
        const ids = ['interaction-help', 'frame-info', 'status', 'pointer-coordinates'];
        return ids.every(id => {
          const element = document.getElementById(id);
          const rect = element.getBoundingClientRect();
          return element.closest('footer') && rect.top >= 0 && rect.bottom <= innerHeight &&
            rect.left >= 0 && rect.right <= innerWidth;
        }) && document.getElementById('host').getBoundingClientRect().width <= 200 &&
          document.getElementById('username').getBoundingClientRect().width <= 150
      })()`), true, 'footer text remains fully visible and connection fields stay compact');
    }
    window.setBounds(originalBounds);
    console.log('PASS: screen frame matches phone aspect ratio and fits default, minimum and wide windows');

    const info = await window.webContents.executeJavaScript("document.getElementById('device-info').textContent");
    assert.match(info, /Primary display: \d+ x \d+/);
    assert.match(info, /SELinux: (Enforcing|Permissive|Disabled)/);
    console.log(`PASS: initial display and policy checks shown: ${info}`);

    if (info.includes('SELinux: Enforcing')) {
      let confirmationCount = 0;
      const originalDialog = dialog.showMessageBox;
      dialog.showMessageBox = async (_window, options) => {
        assert.equal(options.defaultId, 0);
        assert.equal(options.cancelId, 0);
        assert.match(options.detail, /Closing this app does not restore/);
        confirmationCount++;
        return { response: 0 };
      };
      try {
        await window.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true, cancelable: true }))`);
        await waitFor(window, "document.getElementById('viewer').getAttribute('aria-busy') === 'false'");
        assert.equal(confirmationCount, 1);
        assert.equal(await window.webContents.executeJavaScript("document.getElementById('status').textContent"), 'SELinux change cancelled.');
        assert.match(await window.webContents.executeJavaScript("document.getElementById('device-info').textContent"), /SELinux: Enforcing/);
        await window.webContents.executeJavaScript(`document.getElementById('host').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true, cancelable: true }))`);
        assert.equal(await window.webContents.executeJavaScript("document.getElementById('viewer').getAttribute('aria-busy')"), 'false');
        assert.equal(confirmationCount, 1);
        console.log('PASS: S shortcut requests confirmation; cancellation preserves Enforcing; form fields ignore S');
      } finally {
        dialog.showMessageBox = originalDialog;
      }
    } else {
      console.log('SKIP: S confirmation cancellation test requires Enforcing; no real SELinux changes made');
    }

    await window.webContents.executeJavaScript("document.querySelector('[data-key=\"HOME\"]').click()");
    await waitFor(window, "document.getElementById('viewer').getAttribute('aria-busy') === 'false'");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('error').hidden"), true);
    console.log('PASS: Home button sends real input and refreshes screenshot');

    for (let pull = 1; pull <= 2; pull++) {
      await window.webContents.executeJavaScript("document.getElementById('pull-down-menu').click()");
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('pull-down-menu').disabled"), true);
      await waitFor(window, "document.getElementById('viewer').getAttribute('aria-busy') === 'false'");
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('error').hidden"), true);
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('pull-down-menu').disabled"), false);
      console.log(`PASS: pull-down menu ${pull} sends swipe and renders refreshed screen`);
    }
    await window.webContents.executeJavaScript("document.querySelector('[data-key=\"HOME\"]').click()");
    await waitFor(window, "document.getElementById('viewer').getAttribute('aria-busy') === 'false'");

    await window.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }))`);
    await waitFor(window, "document.getElementById('viewer').getAttribute('aria-busy') === 'false'");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('error').hidden"), true);
    console.log('PASS: Space refresh');

    const lastFrame = await window.webContents.executeJavaScript("document.getElementById('frame-info').textContent");
    await waitFor(window, `document.getElementById('frame-info').textContent !== ${JSON.stringify(lastFrame)} && document.getElementById('viewer').getAttribute('aria-busy') === 'false'`, 45000);
    console.log('PASS: automatic refresh after ten seconds');

    await window.webContents.executeJavaScript("document.getElementById('connect').click()");
    await waitFor(window, "document.getElementById('connect').textContent === 'Connect' && !document.getElementById('connect').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('host').disabled || document.getElementById('username').disabled"), false);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('screen').hidden && !document.getElementById('screen').hasAttribute('src')"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('refresh').disabled && document.getElementById('pull-down-menu').disabled"), true);
    await new Promise((resolve) => setTimeout(resolve, 11000));
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('status').textContent"), 'Disconnected. Automatic refresh stopped.');
    console.log('PASS: Disconnect clears screen, disables controls, unlocks settings and stops polling');

    await window.webContents.executeJavaScript("document.getElementById('connect').click()");
    await waitFor(window, "document.getElementById('connect').textContent === 'Disconnect' && !document.getElementById('connect').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('screen').hidden"), false);
    await window.webContents.executeJavaScript("document.getElementById('connect').click()");
    await waitFor(window, "document.getElementById('connect').textContent === 'Connect' && !document.getElementById('connect').disabled");
    console.log('PASS: reconnect after explicit disconnect');

    await window.webContents.executeJavaScript(`document.getElementById('host').value = '-invalid'; document.getElementById('connect').click()`);
    await waitFor(window, "!document.getElementById('error').hidden");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('screen').hidden"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('refresh').disabled"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('auto-refresh').checked"), false);
    console.log('PASS: invalid connection surfaces error, clears old screen and pauses polling');
  }
  assert.deepEqual(errors, [], 'no renderer console errors');
  const image = await window.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  console.log('PASS: app window paints successfully');
  if (desktopData) await rm(desktopData, { recursive: true });
  if (screenshotData) await rm(screenshotData, { recursive: true });
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  if (desktopData) await rm(desktopData, { recursive: true });
  if (screenshotData) await rm(screenshotData, { recursive: true });
  app.exit(1);
});
