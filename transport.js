import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const KEYS = new Set(['HOME', 'BACK', 'APP_SWITCH', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'ENTER', 'DEL']);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshExecutable(platform = process.platform) {
  if (platform === 'darwin') return '/usr/bin/ssh';
  return platform === 'win32' ? 'ssh.exe' : 'ssh';
}

export function parseScreenSize(output) {
  const physical = /^Physical size: (\d+)x(\d+)\r?$/m.exec(output);
  const override = /^Override size: (\d+)x(\d+)\r?$/m.exec(output);
  if (!physical) throw new Error('Could not read the primary display size from wm size.');
  const parse = (match) => {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 1 || height < 1 || width > 16384 || height > 16384) {
      throw new Error('The device reported unsupported display dimensions.');
    }
    return { width, height };
  };
  return { physical: parse(physical), override: override ? parse(override) : null };
}

export function parseSelinux(output) {
  const state = output.trim();
  if (!['Enforcing', 'Permissive', 'Disabled'].includes(state)) {
    throw new Error('Could not read SELinux state from getenforce.');
  }
  return state;
}

export function validateConnection(value) {
  if (!value || typeof value !== 'object') throw new Error('Connection settings are required.');
  const { host, username, port } = value;
  if (typeof host !== 'string' || host.length > 253 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) {
    throw new Error('Enter an IPv4 address or hostname (for example, a Tailscale address).');
  }
  if (typeof username !== 'string' || username.length > 64 ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(username)) {
    throw new Error('Enter a valid SSH username.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be an integer between 1 and 65535.');
  }
  return { host, username, port };
}

export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 ||
      !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('The device did not return a PNG screenshot. Check root access and screencap.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40000000) {
    throw new Error('The device returned unsupported screenshot dimensions.');
  }
  return { width, height };
}

export function inputCommand(action, size) {
  if (!action || typeof action !== 'object') throw new Error('An input action is required.');
  if (action.type === 'key') {
    if (!KEYS.has(action.key)) throw new Error('Unsupported hardware button.');
    return `/system/bin/input keyevent KEYCODE_${action.key}`;
  }
  if (action.type === 'text') {
    if (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > 1000 ||
        !/^[\x20-\x7e]+$/.test(action.text)) {
      throw new Error('Enter 1-1000 printable ASCII characters (one line, no emoji or accented letters).');
    }
    // Android input text treats "%s" as a space, so send percent signs separately.
    return action.text.split(/(%)/).filter(Boolean)
      .map((part) => `/system/bin/input text ${shellQuote(part)}`).join(' && ');
  }
  if (!size) throw new Error('Refresh the screenshot before sending touch input.');
  if (action.type === 'pull-down-menu') {
    const x = Math.min(size.width - 1, Math.round(size.width * 500 / 1080));
    const endY = Math.min(size.height - 1, Math.round(size.height * 900 / 2340));
    return inputCommand({ type: 'swipe', x, y: 0, endX: x, endY, duration: 300 }, size);
  }
  const point = (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= size.width || y >= size.height) {
      throw new Error('Touch coordinates are outside the current screenshot.');
    }
    return `${x} ${y}`;
  };
  if (action.type === 'tap') return `/system/bin/input tap ${point(action.x, action.y)}`;
  if (action.type === 'swipe') {
    const start = point(action.x, action.y);
    const end = point(action.endX, action.endY);
    if (!Number.isInteger(action.duration) || action.duration < 100 || action.duration > 2000) {
      throw new Error('Swipe duration must be between 100 and 2000 milliseconds.');
    }
    return `/system/bin/input swipe ${start} ${end} ${action.duration}`;
  }
  throw new Error('Unsupported input action.');
}

export class AndroidDevice {
  constructor(run = execFileAsync, confirmPermissive = async () => false) {
    this.run = run;
    this.connection = null;
    this.size = null;
    this.busy = false;
    this.deviceInfo = null;
    this.confirmPermissive = confirmPermissive;
  }

  async selinuxState(connection) {
    return parseSelinux((await this.ssh(connection, '/system/bin/getenforce')).toString());
  }

  async ssh(connection, command, screenshot = false) {
    try {
      const { stdout } = await this.run(sshExecutable(), [
        '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2', '-p', String(connection.port),
        `${connection.username}@${connection.host}`, `su -c ${shellQuote(command)}`,
      ], {
        encoding: 'buffer',
        timeout: 30000,
        maxBuffer: screenshot ? 24 * 1024 * 1024 : 256 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('OpenSSH client was not found. Install OpenSSH Client and ensure ssh is on PATH (Windows: Settings > Optional features > OpenSSH Client).', { cause: error });
      }
      const detail = error.stderr?.toString().trim();
      throw new Error(`SSH failed: ${detail || error.message}`, { cause: error });
    }
  }

  async capture(connection) {
    const png = await this.ssh(connection, '/system/bin/screencap -p', true);
    const size = readPngSize(png);
    this.size = size;
    return { ...size, deviceInfo: this.deviceInfo, dataUrl: `data:image/png;base64,${png.toString('base64')}`, capturedAt: Date.now() };
  }

  async request(message) {
    if (this.busy) throw new Error('A device request is already running.');
    this.busy = true;
    try {
      if (!message || typeof message !== 'object') throw new Error('A device request is required.');
      if (message.type === 'connect') {
        this.connection = null;
        this.size = null;
        this.deviceInfo = null;
        const connection = validateConnection(message.connection);
        const screenSize = parseScreenSize((await this.ssh(connection, '/system/bin/wm size')).toString());
        const selinux = await this.selinuxState(connection);
        this.deviceInfo = { screenSize, selinux };
        const frame = await this.capture(connection);
        this.connection = connection;
        return frame;
      }
      if (message.type === 'disconnect') {
        this.connection = null;
        this.size = null;
        this.deviceInfo = null;
        return { disconnected: true };
      }
      if (!this.connection) throw new Error('Connect to a device first.');
      if (message.type === 'toggle-selinux') {
        const state = await this.selinuxState(this.connection);
        this.deviceInfo.selinux = state;
        if (state === 'Disabled') throw new Error('SELinux is disabled in the kernel and cannot be toggled with setenforce.');
        if (state === 'Enforcing' && !await this.confirmPermissive(this.connection)) {
          return { deviceInfo: this.deviceInfo, cancelled: true };
        }
        const target = state === 'Enforcing' ? 'Permissive' : 'Enforcing';
        // Mark unknown before changing policy so a failed verification never shows a stale state.
        this.deviceInfo.selinux = 'Unknown';
        try {
          await this.ssh(this.connection, `/system/bin/setenforce ${target === 'Permissive' ? 0 : 1}`);
          this.deviceInfo.selinux = await this.selinuxState(this.connection);
          if (this.deviceInfo.selinux !== target) throw new Error(`Expected ${target}, received ${this.deviceInfo.selinux}.`);
        } catch (error) {
          throw new Error(`SELinux change could not be verified; check getenforce on the device. ${error.message}`, { cause: error });
        }
        return { deviceInfo: this.deviceInfo };
      }
      if (message.type === 'refresh') return await this.capture(this.connection);
      if (message.type === 'input') {
        const command = inputCommand(message.action, this.size);
        try {
          await this.ssh(this.connection, command);
        } catch (error) {
          throw new Error(`Input may have been partially sent. Check the phone before retrying. ${error.message}`, { cause: error });
        }
        try {
          return await this.capture(this.connection);
        } catch (error) {
          throw new Error(`Input was sent, but screenshot refresh failed. Do not repeat the input blindly. ${error.message}`, { cause: error });
        }
      }
      throw new Error('Unsupported device request.');
    } finally {
      this.busy = false;
    }
  }
}
