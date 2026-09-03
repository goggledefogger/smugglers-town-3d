/**
 * The logger: one call site shape everywhere, three places the entry goes.
 *
 * - The console, at `info` and up (everything with `?debug` in the URL).
 * - A ring buffer of the last `RING` entries, so a player can hand over a
 *   transcript after something went wrong (`stt.dump()` in the console, or
 *   the lobby's copy link).
 * - An optional remote sink, attached once Firebase is up, which also gets
 *   the buffered entries so the sign-in and first requests are not lost.
 *
 * Entries are small on purpose: a level, a scope, a short message, and an
 * optional JSON blob capped in size. `core/` does not log; it returns.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ms since epoch */
  readonly t: number;
  readonly l: Level;
  readonly s: string;
  readonly m: string;
  /** JSON, at most DATA_MAX chars */
  readonly d?: string;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const RING = 500;
const DATA_MAX = 1000;
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const ring: LogEntry[] = [];
let remote: LogSink | null = null;
let remoteLevel: Level = 'info';
const consoleLevel: Level =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug') ? 'debug' : 'info';

function toJson(data: unknown): string {
  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, code: (v as { code?: string }).code } : v)) ?? String(data);
  } catch {
    text = String(data);
  }
  return text.length > DATA_MAX ? text.slice(0, DATA_MAX - 1) + '…' : text;
}

function emit(l: Level, s: string, m: string, data?: unknown): void {
  const entry: LogEntry = data === undefined ? { t: Date.now(), l, s, m } : { t: Date.now(), l, s, m, d: toJson(data) };
  ring.push(entry);
  if (ring.length > RING) ring.shift();
  if (ORDER[l] >= ORDER[consoleLevel]) {
    const line = `[${s}] ${m}`;
    const out = l === 'debug' ? console.log : l === 'info' ? console.info : l === 'warn' ? console.warn : console.error;
    if (entry.d !== undefined) out(line, entry.d);
    else out(line);
  }
  if (remote && ORDER[l] >= ORDER[remoteLevel]) remote(entry);
}

export function logger(scope: string): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d)
  };
}

/** Send entries at `level` and up to `sink` from now on, starting with what is already buffered. */
export function attachRemoteLog(sink: LogSink, level: Level = 'info'): void {
  remote = sink;
  remoteLevel = level;
  for (const e of ring) if (ORDER[e.l] >= ORDER[level]) sink(e);
}

export function detachRemoteLog(): void {
  remote = null;
}

export function logEntries(): readonly LogEntry[] {
  return ring;
}

/** One JSON object per line, oldest first: paste-friendly. */
export function dumpLogs(): string {
  return ring.map(e => JSON.stringify(e)).join('\n');
}

/** For tests. */
export function clearLogs(): void {
  ring.length = 0;
  remote = null;
  remoteLevel = 'info';
}

if (typeof window !== 'undefined') {
  (window as unknown as { stt: unknown }).stt = { logs: logEntries, dump: dumpLogs };
}
