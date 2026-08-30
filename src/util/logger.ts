import fs from 'node:fs';
import path from 'node:path';
import { orbitPaths } from './paths.js';
import { redact, redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LoggerState {
  enabled: boolean;
  level: LogLevel;
  stream: fs.WriteStream | null;
  file: string | null;
}

const state: LoggerState = { enabled: false, level: 'debug', stream: null, file: null };

/**
 * Enable file logging (`orbit --debug`). Logs go to `~/.orbit/logs`, never stdout,
 * because stdout belongs to the Ink UI.
 */
export function enableDebugLogging(level: LogLevel = 'debug'): string {
  if (state.enabled && state.file) return state.file;
  fs.mkdirSync(orbitPaths.logs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(orbitPaths.logs, `orbit-${stamp}.log`);
  state.stream = fs.createWriteStream(file, { flags: 'a' });
  state.enabled = true;
  state.level = level;
  state.file = file;
  write('info', 'logger', 'debug logging started', { pid: process.pid, node: process.version });
  return file;
}

export function isDebugEnabled(): boolean {
  return state.enabled;
}

export function logFilePath(): string | null {
  return state.file;
}

function write(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!state.enabled || !state.stream) return;
  if (LEVELS[level] < LEVELS[state.level]) return;
  const entry: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: redact(message),
  };
  if (data !== undefined) entry.data = redactValue(data);
  try {
    state.stream.write(JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break the app.
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
  };
}

export function closeLogger(): void {
  state.stream?.end();
  state.stream = null;
  state.enabled = false;
}
