import { screenPoint, gestureAction, fitScreen } from './geometry.js';

const $ = (id) => document.getElementById(id);
const screen = $('screen');
const deviceButtons = [...document.querySelectorAll('[data-key]'), $('refresh'), $('selinux'), $('pull-down-menu')];
const connectionFieldIds = ['host', 'username', 'port'];
let connected = false;
let busy = false;
let frame = null;
let timer = null;
let gesture = null;
let connectionLabel = '';
let deviceInfo = null;
let screenshotReady = false;

for (const id of connectionFieldIds) {
  const key = `kvm-droid.${id}`;
  const savedValue = localStorage.getItem(key);
  if (savedValue !== null) $(id).value = savedValue;
  $(id).addEventListener('input', () => localStorage.setItem(key, $(id).value));
}

function fitViewer() {
  clearCoordinates();
  const stage = $('screen-stage');
  const size = fitScreen(stage.clientWidth, stage.clientHeight, frame?.width ?? 1080, frame?.height ?? 2340);
  $('viewer').style.width = `${size.width}px`;
  $('viewer').style.height = `${size.height}px`;
}

new ResizeObserver(fitViewer).observe($('screen-stage'));

function showDeviceInfo(info) {
  deviceInfo = info;
  const { physical, override } = info.screenSize;
  $('device-info').textContent = `Primary display: ${physical.width} x ${physical.height}` +
    (override ? ` (override: ${override.width} x ${override.height})` : '') +
    `. SELinux: ${info.selinux}.`;
  $('selinux').disabled = busy || !connected || info.selinux === 'Disabled';
}

function scheduleRefresh() {
  clearTimeout(timer);
  if (connected && $('auto-refresh').checked && !busy && !gesture) {
    timer = setTimeout(() => request({ type: 'refresh' }, 'Refreshing screen...'), 10000);
  }
}

function setBusy(value) {
  busy = value;
  $('viewer').setAttribute('aria-busy', String(value));
  $('working').hidden = !value;
  for (const element of $('connection-form').elements) {
    element.disabled = value || (connected && element.tagName === 'INPUT');
  }
  $('connect').textContent = connected ? 'Disconnect' : 'Connect';
  $('connect').classList.toggle('disconnect', connected);
  for (const button of deviceButtons) button.disabled = value || !connected;
  if (deviceInfo?.selinux === 'Disabled') $('selinux').disabled = true;
  $('save-screenshot').disabled = value || !frame || !screenshotReady;
  $('screenshot-directory').disabled = value;
  $('phone-text').disabled = value || !connected;
  $('send-text').disabled = value || !connected || !$('phone-text').value.length;
  $('ocr-screen').disabled = value || !frame;
}

async function screenshotRequest(action) {
  if (busy) return;
  clearTimeout(timer);
  gesture = null;
  setBusy(true);
  $('error').hidden = true;
  if (action === 'ocr') {
    $('status').textContent = 'Reading screen text locally...';
    $('ocr-text').value = '';
    $('ocr-info').textContent = 'Running offline English OCR...';
  }
  try {
    const result = await window.android.screenshots(action);
    if (!result.ok) throw new Error(result.error);
    if (result.directory) {
      $('screenshot-path').textContent = result.directory;
      $('screenshot-path').title = result.directory;
      screenshotReady = true;
    }
    if (result.path) $('status').textContent = `Screenshot saved: ${result.path}`;
    if (action === 'ocr') {
      $('ocr-text').value = result.text;
      $('ocr-info').textContent = result.text.trim() ?
        `Text from screenshot captured ${new Date(frame.capturedAt).toLocaleTimeString()}.` :
        'No text detected in this screenshot.';
      $('status').textContent = 'Offline OCR complete.';
    }
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('status').textContent = 'Screenshot operation failed.';
    if (action === 'ocr') $('ocr-info').textContent = 'OCR failed. See the error below.';
  } finally {
    setBusy(false);
    scheduleRefresh();
  }
}

$('save-screenshot').addEventListener('click', () => screenshotRequest('save'));
$('screenshot-directory').addEventListener('click', () => screenshotRequest('choose'));
$('ocr-screen').addEventListener('click', () => screenshotRequest('ocr'));
screenshotRequest('directory');

async function showFrame(nextFrame) {
  const image = new Image();
  image.src = nextFrame.dataUrl;
  await image.decode();
  screen.src = nextFrame.dataUrl;
  frame = nextFrame;
  fitViewer();
  screen.hidden = false;
  $('placeholder').hidden = true;
  $('frame-info').textContent = `${frame.width} x ${frame.height} / ${new Date(frame.capturedAt).toLocaleTimeString()}`;
}

async function request(message, label) {
  if (busy) return;
  clearTimeout(timer);
  gesture = null;
  setBusy(true);
  $('status').textContent = label;
  $('error').hidden = true;
  if (message.type === 'connect') {
    $('ocr-text').value = '';
    $('ocr-info').textContent = 'English OCR of the displayed screenshot. Runs locally; no uploads.';
    connected = false;
    frame = null;
    fitViewer();
    deviceInfo = null;
    $('device-info').textContent = 'Checking display size and SELinux state...';
    screen.hidden = true;
    screen.removeAttribute('src');
    $('placeholder').hidden = false;
    $('connection-state').textContent = 'Connecting...';
    $('connection-state').classList.remove('connected');
    $('frame-info').textContent = 'No screenshot yet';
    connectionLabel = `${message.connection.host}:${message.connection.port}`;
  }
  try {
    const result = await window.android.request(message);
    if (!result.ok) throw new Error(result.error);
    if (message.type === 'disconnect') {
      $('ocr-text').value = '';
      connected = false;
      frame = null;
      deviceInfo = null;
      connectionLabel = '';
      screen.hidden = true;
      screen.removeAttribute('src');
      $('placeholder').hidden = false;
      $('frame-info').textContent = 'No screenshot yet';
      $('device-info').textContent = 'Display size and SELinux state checked on connection.';
      $('connection-state').textContent = 'Not connected';
      $('connection-state').classList.remove('connected');
      $('status').textContent = 'Disconnected. Automatic refresh stopped.';
      fitViewer();
      return;
    }
    if (result.frame.dataUrl) await showFrame(result.frame);
    if (message.type === 'input' && message.action.type === 'text') $('phone-text').value = '';
    connected = true;
    showDeviceInfo(result.frame.deviceInfo);
    $('connection-state').textContent = connectionLabel;
    $('connection-state').classList.add('connected');
    $('status').textContent = result.frame.cancelled ? 'SELinux change cancelled.' :
      message.type === 'toggle-selinux' ? `SELinux: ${deviceInfo.selinux}. Screen unchanged; press Space to refresh.` :
      'Screen updated. Click to tap or drag to swipe.';
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('status').textContent = 'Request failed. Check the connection and try Refresh.';
    $('connection-state').textContent = connected ? 'Connection issue / stale screen' : 'Not connected';
    $('connection-state').classList.remove('connected');
    // Require an explicit retry rather than polling a failing device indefinitely.
    $('auto-refresh').checked = false;
    if (message.type === 'connect') $('device-info').textContent = 'Connection checks failed.';
    if (message.type === 'toggle-selinux' && deviceInfo) {
      showDeviceInfo({ ...deviceInfo, selinux: 'Unknown; press S to recheck before toggling' });
    }
  } finally {
    setBusy(false);
    scheduleRefresh();
  }
}

$('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (connected) {
    request({ type: 'disconnect' }, 'Disconnecting...');
    return;
  }
  request({
    type: 'connect',
    connection: { host: $('host').value.trim(), username: $('username').value.trim(), port: Number($('port').value) },
  }, 'Connecting and capturing screen...');
});
$('refresh').addEventListener('click', () => request({ type: 'refresh' }, 'Refreshing screen...'));
$('auto-refresh').addEventListener('change', scheduleRefresh);
$('selinux').addEventListener('click', () => request({ type: 'toggle-selinux' }, 'Checking SELinux state...'));
$('pull-down-menu').addEventListener('click', () => request({
  type: 'input', action: { type: 'pull-down-menu' },
}, 'Pulling down the top menu...'));
$('phone-text').addEventListener('input', () => {
  $('send-text').disabled = busy || !connected || !$('phone-text').value.length;
});
$('phone-text').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
  event.preventDefault();
  $('send-text').click();
});
$('send-text').addEventListener('click', async () => {
  if (busy || !connected || !$('phone-text').value.length || !$('phone-text').reportValidity()) return;
  await request({ type: 'input', action: { type: 'text', text: $('phone-text').value } }, 'Sending text...');
  if (connected) $('phone-text').focus();
});
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => request({
    type: 'input', action: { type: 'key', key: button.dataset.key },
  }, `Sending ${button.textContent}...`));
}
document.addEventListener('keydown', (event) => {
  if (!['Space', 'KeyS'].includes(event.code) || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
      event.target.closest('input, button, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  if (connected && !busy) {
    if (event.code === 'KeyS') $('selinux').click();
    else request({ type: 'refresh' }, 'Refreshing screen...');
  }
});

function point(event) {
  return frame ? screenPoint(event.clientX, event.clientY, screen.getBoundingClientRect(), frame.width, frame.height) : null;
}

function clearCoordinates() {
  $('pointer-coordinates').textContent = 'X: -- / Y: --';
}

screen.addEventListener('pointermove', (event) => {
  const position = connected && !screen.hidden ? point(event) : null;
  $('pointer-coordinates').textContent = position ? `X: ${position.x} / Y: ${position.y}` : 'X: -- / Y: --';
});
screen.addEventListener('pointerleave', clearCoordinates);
screen.addEventListener('pointercancel', clearCoordinates);
window.addEventListener('blur', clearCoordinates);

screen.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary || busy || !connected) return;
  const start = point(event);
  if (!start) return;
  event.preventDefault();
  clearTimeout(timer);
  gesture = { start, time: performance.now(), clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
  screen.setPointerCapture(event.pointerId);
});
screen.addEventListener('pointerup', (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const start = gesture;
  gesture = null;
  screen.releasePointerCapture(event.pointerId);
  const end = point(event);
  if (!end || busy) {
    scheduleRefresh();
    return;
  }
  const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
  const action = gestureAction(start.start, end, performance.now() - start.time, distance);
  request({ type: 'input', action }, action.type === 'tap' ? 'Sending tap...' : 'Sending gesture...');
});
screen.addEventListener('lostpointercapture', () => {
  if (gesture) {
    gesture = null;
    scheduleRefresh();
  }
});
screen.addEventListener('contextmenu', (event) => event.preventDefault());
