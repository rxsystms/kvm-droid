import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AndroidDevice, inputCommand, readPngSize, validateConnection, parseScreenSize, parseSelinux, sshExecutable } from '../transport.js';
import { screenPoint, gestureAction, fitScreen } from '../geometry.js';

const connection = { host: '99.116.233.85', username: 'u0_a227', port: 8022 };
function png(width = 1080, height = 2340) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function stdout(args, state = 'Enforcing') {
  const command = args.at(-1);
  if (command.includes('wm size')) return Buffer.from('Physical size: 1080x2340\n');
  if (command.includes('getenforce')) return Buffer.from(`${state}\n`);
  return command.includes('screencap') ? png() : Buffer.alloc(0);
}

test('screen size parses physical and override sizes and rejects malformed output', () => {
  assert.deepEqual(parseScreenSize('Physical size: 1080x2340\r\nOverride size: 720x1560\r\n'), {
    physical: { width: 1080, height: 2340 }, override: { width: 720, height: 1560 },
  });
  assert.equal(parseScreenSize('Physical size: 1080x2340\n').override, null);
  for (const output of ['', 'permission denied', 'Physical size: 0x2340', 'Physical size: 20000x100']) {
    assert.throws(() => parseScreenSize(output));
  }
  for (const state of ['Enforcing', 'Permissive', 'Disabled']) assert.equal(parseSelinux(`${state}\r\n`), state);
  assert.throws(() => parseSelinux('unexpected state'));
});

test('connection settings reject option and shell injection, invalid ports and missing fields', () => {
  assert.deepEqual(validateConnection(connection), connection);
  assert.deepEqual(validateConnection({ ...connection, host: 'phone.tailnet.ts.net' }).host, 'phone.tailnet.ts.net');
  for (const host of ['-oProxyCommand=bad', 'host;id', 'user@host', 'a b', '', null]) {
    assert.throws(() => validateConnection({ ...connection, host }));
  }
  for (const username of ['-root', "user'bad", 'a@b', '', null]) {
    assert.throws(() => validateConnection({ ...connection, username }));
  }
  for (const port of [0, 65536, 8022.5, '8022', NaN]) {
    assert.throws(() => validateConnection({ ...connection, port }));
  }
  assert.throws(() => validateConnection(null));
});

test('PNG header dimensions are checked, including rotated screens', () => {
  assert.deepEqual(readPngSize(png()), { width: 1080, height: 2340 });
  assert.deepEqual(readPngSize(png(2340, 1080)), { width: 2340, height: 1080 });
  for (const value of [Buffer.from('permission denied'), png(0), png(20000), png(10000, 10000)]) {
    assert.throws(() => readPngSize(value));
  }
});

test('input uses an allowlist and bounds from the latest screenshot', () => {
  const size = { width: 1080, height: 2340 };
  assert.equal(inputCommand({ type: 'key', key: 'HOME' }), '/system/bin/input keyevent KEYCODE_HOME');
  assert.equal(inputCommand({ type: 'tap', x: 1079, y: 2339 }, size), '/system/bin/input tap 1079 2339');
  assert.equal(inputCommand({ type: 'swipe', x: 500, y: 0, endX: 500, endY: 900, duration: 300 }, size),
    '/system/bin/input swipe 500 0 500 900 300');
  for (const action of [
    { type: 'key', key: 'HOME; id' }, { type: 'tap', x: -1, y: 0 },
    { type: 'tap', x: 1080, y: 0 }, { type: 'tap', x: 0, y: 2340 },
    { type: 'tap', x: '0', y: 0 }, { type: 'tap', x: 0.1, y: 0 },
    { type: 'swipe', x: 0, y: 0, endX: 0, endY: 0, duration: 2001 },
    { type: 'shell', command: 'id' }, null,
  ]) assert.throws(() => inputCommand(action, size));
  assert.throws(() => inputCommand({ type: 'tap', x: 0, y: 0 }));
});

test('coordinates respect rendered size, offsets, edges and rotation', () => {
  const rect = { left: 100, top: 20, width: 270, height: 585 };
  assert.deepEqual(screenPoint(235, 312.5, rect, 1080, 2340), { x: 540, y: 1170 });
  assert.deepEqual(screenPoint(370, 605, rect, 1080, 2340), { x: 1079, y: 2339 });
  assert.equal(screenPoint(99, 20, rect, 1080, 2340), null);
  assert.equal(screenPoint(200, 606, rect, 1080, 2340), null);
  assert.equal(screenPoint(100, 20, { ...rect, width: 0 }, 1080, 2340), null);
  assert.deepEqual(screenPoint(235, 312.5, rect, 2340, 1080), { x: 1170, y: 540 });
});

test('text input accepts printable ASCII and rejects unsupported characters and lengths', () => {
  assert.equal(inputCommand({ type: 'text', text: 'hello world' }), "/system/bin/input text 'hello world'");
  assert.equal(inputCommand({ type: 'text', text: '%s' }),
    "/system/bin/input text '%' && /system/bin/input text 's'");
  assert.equal(inputCommand({ type: 'key', key: 'ENTER' }), '/system/bin/input keyevent KEYCODE_ENTER');
  assert.equal(inputCommand({ type: 'key', key: 'DEL' }), '/system/bin/input keyevent KEYCODE_DEL');
  assert.ok(inputCommand({ type: 'text', text: 'x'.repeat(1000) }));
  for (const text of ['', 'x'.repeat(1001), 'a\nb', '\t', '\0', '\x7f', 'caf\u00e9', '\ud83d\ude00', null, 42]) {
    assert.throws(() => inputCommand({ type: 'text', text }), /printable ASCII/);
  }
});

test('text stays literal through both remote shell layers, including spaces, quotes and percent-s', {
  skip: process.platform === 'win32',
}, async () => {
  const text = `Hello "world", it's 100% safe; $HOME & < > | \\ ! \`literal\` %s %%s  `;
  const calls = [];
  const device = new AndroidDevice(async (_file, args) => {
    calls.push(args.at(-1));
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  await device.request({ type: 'input', action: { type: 'text', text } });
  assert.equal(calls.length, 5, 'text input is followed by one screenshot, with no retries');
  const command = execFileSync('/bin/sh', ['-c', calls[3].replace('su -c ', "printf '%s' ")]).toString();
  assert.equal(command, inputCommand({ type: 'text', text }));
  const parts = execFileSync('/bin/sh', ['-c',
    command.replaceAll('/system/bin/input text', "printf '%s\\n'")]).toString().slice(0, -1).split('\n');
  // Model Android's special replacement; percent-s must never occur within one argument.
  assert.equal(parts.map((part) => part.replaceAll('%s', ' ')).join(''), text);
  await device.request({ type: 'disconnect' });
  await assert.rejects(device.request({ type: 'input', action: { type: 'text', text } }), /Connect/);
});

test('text failures are explicit, never retried, and invalid text never reaches SSH', async () => {
  let inputs = 0;
  const device = new AndroidDevice(async (_file, args) => {
    if (args.at(-1).includes('/system/bin/input text')) {
      inputs++;
      throw new Error('connection lost');
    }
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  await assert.rejects(device.request({ type: 'input', action: { type: 'text', text: '\n' } }), /ASCII/);
  assert.equal(inputs, 0);
  await assert.rejects(device.request({ type: 'input', action: { type: 'text', text: 'hello' } }), /partially sent.*Check the phone/);
  assert.equal(inputs, 1);
  assert.equal(device.busy, false);
});

test('screen frame fits portrait, landscape and narrow windows without square padding', () => {
  for (const [availableWidth, availableHeight, width, height] of [
    [700, 650, 1080, 2340], [700, 650, 2340, 1080], [200, 650, 1080, 2340],
  ]) {
    const fitted = fitScreen(availableWidth, availableHeight, width, height);
    assert.ok(fitted.width <= availableWidth && fitted.height <= availableHeight);
    assert.ok(Math.abs(fitted.width / fitted.height - width / height) < 0.00001);
    assert.ok(fitted.width === availableWidth || fitted.height === availableHeight);
  }
  assert.deepEqual(fitScreen(0, 0, 1080, 2340), { width: 0, height: 0 });
});

test('pull-down menu uses the requested swipe, scales for other screens and requires a screenshot', () => {
  assert.equal(inputCommand({ type: 'pull-down-menu' }, { width: 1080, height: 2340 }),
    '/system/bin/input swipe 500 0 500 900 300');
  assert.equal(inputCommand({ type: 'pull-down-menu' }, { width: 540, height: 1170 }),
    '/system/bin/input swipe 250 0 250 450 300');
  assert.equal(inputCommand({ type: 'pull-down-menu' }, { width: 2340, height: 1080 }),
    '/system/bin/input swipe 1083 0 1083 415 300');
  assert.throws(() => inputCommand({ type: 'pull-down-menu' }), /Refresh the screenshot/);
});

test('gestures distinguish taps, swipes and long presses and clamp durations', () => {
  const start = { x: 10, y: 20 };
  const end = { x: 20, y: 200 };
  assert.deepEqual(gestureAction(start, start, 100, 1), { type: 'tap', ...start });
  assert.equal(gestureAction(start, end, 20, 50).duration, 100);
  assert.equal(gestureAction(start, end, 4000, 50).duration, 2000);
  assert.deepEqual(gestureAction(start, start, 700, 0),
    { type: 'swipe', ...start, endX: 10, endY: 20, duration: 700 });
});

test('connect, input and refresh use SSH buffers without local or remote image files', async () => {
  const calls = [];
  const device = new AndroidDevice(async (...args) => {
    calls.push(args);
    return { stdout: stdout(args[1]) };
  });
  const frame = await device.request({ type: 'connect', connection });
  assert.equal(frame.width, 1080);
  assert.deepEqual(frame.deviceInfo, {
    screenSize: { physical: { width: 1080, height: 2340 }, override: null }, selinux: 'Enforcing',
  });
  assert.ok(frame.dataUrl.startsWith('data:image/png;base64,'));
  await device.request({ type: 'input', action: { type: 'tap', x: 20, y: 40 } });
  await device.request({ type: 'refresh' });
  assert.equal(calls.length, 6);
  assert.equal(calls[0][0], sshExecutable());
  assert.ok(calls[0][1].includes('StrictHostKeyChecking=yes'));
  assert.equal(calls[0][1].at(-1), "su -c '/system/bin/wm size'");
  assert.equal(calls[1][1].at(-1), "su -c '/system/bin/getenforce'");
  assert.equal(calls[2][1].at(-1), "su -c '/system/bin/screencap -p'");
  assert.equal(calls[3][1].at(-1), "su -c '/system/bin/input tap 20 40'");
  assert.equal(calls[0][2].encoding, 'buffer');
});

test('SSH executable selection supports Linux, macOS GUI launches and Windows', () => {
  assert.equal(sshExecutable('linux'), 'ssh');
  assert.equal(sshExecutable('darwin'), '/usr/bin/ssh');
  assert.equal(sshExecutable('win32'), 'ssh.exe');
});

test('missing OpenSSH surfaces installation guidance', async () => {
  const device = new AndroidDevice(async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  });
  await assert.rejects(device.request({ type: 'connect', connection }), /Install OpenSSH Client/);
  assert.equal(device.connection, null);
});

test('failed connections do not retain an old target and errors are actionable', async () => {
  let fail = false;
  const device = new AndroidDevice(async (_file, args) => {
    if (fail) throw Object.assign(new Error('exit 255'), { stderr: Buffer.from('Permission denied (publickey)') });
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  fail = true;
  await assert.rejects(device.request({ type: 'connect', connection }), /Permission denied/);
  await assert.rejects(device.request({ type: 'refresh' }), /Connect to a device first/);
  assert.equal(device.busy, false);
});

test('input is not retried when its following capture fails', async () => {
  let calls = 0;
  const device = new AndroidDevice(async (_file, args) => {
    calls++;
    if (calls === 5) throw new Error('capture timed out');
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  await assert.rejects(device.request({ type: 'input', action: { type: 'key', key: 'HOME' } }),
    /Input was sent, but screenshot refresh failed/);
  assert.equal(calls, 5);
});

test('invalid reconnection settings discard the previous target before validation', async () => {
  const device = new AndroidDevice(async (_file, args) => ({ stdout: stdout(args) }));
  await device.request({ type: 'connect', connection });
  await assert.rejects(device.request({ type: 'connect', connection: { ...connection, host: '-invalid' } }),
    /IPv4 address or hostname/);
  await assert.rejects(device.request({ type: 'input', action: { type: 'key', key: 'HOME' } }),
    /Connect to a device first/);
  assert.equal(device.size, null);
});

test('disconnect clears the target without SSH and permits a fresh connection', async () => {
  let calls = 0;
  const device = new AndroidDevice(async (_file, args) => {
    calls++;
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  const before = calls;
  assert.deepEqual(await device.request({ type: 'disconnect' }), { disconnected: true });
  assert.equal(calls, before);
  assert.equal(device.connection, null);
  assert.equal(device.size, null);
  assert.equal(device.deviceInfo, null);
  for (const message of [
    { type: 'refresh' }, { type: 'toggle-selinux' },
    { type: 'input', action: { type: 'key', key: 'HOME' } },
  ]) await assert.rejects(device.request(message), /Connect to a device first/);
  await device.request({ type: 'disconnect' });
  await device.request({ type: 'connect', connection });
  assert.deepEqual(device.connection, connection);
});

test('overlapping requests are rejected rather than queued as stale input', async () => {
  let resolve;
  const device = new AndroidDevice((_file, args) => args.at(-1).includes('screencap') ?
    new Promise((done) => { resolve = done; }) : Promise.resolve({ stdout: stdout(args) }));
  const pending = device.request({ type: 'connect', connection });
  await assert.rejects(device.request({ type: 'refresh' }), /already running/);
  while (!resolve) await new Promise((done) => setImmediate(done));
  resolve({ stdout: png() });
  await pending;
  assert.equal(device.busy, false);
});

test('SELinux toggle confirms permissive, verifies changes and restores enforcing without confirmation', async () => {
  let state = 'Enforcing';
  let confirmations = 0;
  const commands = [];
  const device = new AndroidDevice(async (_file, args) => {
    const command = args.at(-1);
    commands.push(command);
    if (command.includes('setenforce 0')) state = 'Permissive';
    if (command.includes('setenforce 1')) state = 'Enforcing';
    return { stdout: stdout(args, state) };
  }, async (target) => {
    assert.deepEqual(target, connection);
    confirmations++;
    return true;
  });
  await device.request({ type: 'connect', connection });
  assert.equal((await device.request({ type: 'toggle-selinux' })).deviceInfo.selinux, 'Permissive');
  assert.equal((await device.request({ type: 'toggle-selinux' })).deviceInfo.selinux, 'Enforcing');
  assert.equal(confirmations, 1);
  assert.equal(commands.filter((command) => command.includes('setenforce')).length, 2);
  assert.equal(commands.filter((command) => command.includes('screencap')).length, 1);
});

test('cancelling permissive or using the default confirmation never changes device policy', async () => {
  const commands = [];
  const device = new AndroidDevice(async (_file, args) => {
    commands.push(args.at(-1));
    return { stdout: stdout(args) };
  });
  await device.request({ type: 'connect', connection });
  assert.equal((await device.request({ type: 'toggle-selinux' })).cancelled, true);
  assert.equal(commands.some((command) => command.includes('setenforce')), false);
});

test('SELinux reads live state, rejects disabled policy and reports failed verification', async () => {
  let state = 'Enforcing';
  const device = new AndroidDevice(async (_file, args) => ({ stdout: stdout(args, state) }), async () => true);
  await assert.rejects(device.request({ type: 'toggle-selinux' }), /Connect to a device first/);
  await device.request({ type: 'connect', connection });
  state = 'Disabled';
  await assert.rejects(device.request({ type: 'toggle-selinux' }), /disabled in the kernel/);
  state = 'Enforcing';
  await assert.rejects(device.request({ type: 'toggle-selinux' }), /could not be verified/);
  assert.equal(device.busy, false);
});

test('initial display check failure prevents connection and capture', async () => {
  const commands = [];
  const device = new AndroidDevice(async (_file, args) => {
    commands.push(args.at(-1));
    return { stdout: Buffer.from('unexpected wm response') };
  });
  await assert.rejects(device.request({ type: 'connect', connection }), /primary display size/);
  assert.equal(device.connection, null);
  assert.equal(commands.length, 1);
});
