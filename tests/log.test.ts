import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, attachRemoteLog, logEntries, dumpLogs, clearLogs, type LogEntry } from '../src/app/log.ts';

describe('logger', () => {
  beforeEach(() => {
    clearLogs();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps entries with scope, level and JSON data', () => {
    const log = logger('net');
    log.info('hello', { code: 'AB12' });
    log.warn('careful');
    const [a, b] = logEntries();
    expect(a).toMatchObject({ l: 'info', s: 'net', m: 'hello', d: '{"code":"AB12"}' });
    expect(b).toMatchObject({ l: 'warn', m: 'careful' });
    expect(b!.d).toBeUndefined();
    expect(dumpLogs().split('\n')).toHaveLength(2);
  });

  it('serialises errors with their code and caps data size', () => {
    const log = logger('x');
    const err = Object.assign(new Error('nope'), { code: 'auth/whatever' });
    log.error('failed', err);
    expect(logEntries()[0]!.d).toContain('auth/whatever');
    log.info('big', 'x'.repeat(5000));
    expect(logEntries()[1]!.d!.length).toBeLessThanOrEqual(1000);
  });

  it('backfills a remote sink with buffered entries at its level and up', () => {
    const log = logger('a');
    log.debug('quiet');
    log.info('one');
    log.error('two');
    const got: LogEntry[] = [];
    attachRemoteLog(e => got.push(e), 'info');
    expect(got.map(e => e.m)).toEqual(['one', 'two']);
    log.warn('three');
    log.debug('still quiet');
    expect(got.map(e => e.m)).toEqual(['one', 'two', 'three']);
  });
});
