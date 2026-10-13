import { Prisma } from '@prisma/client';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorBody, isDatabaseUnavailable } from './http';

describe('dependency outages are reported as 503, retryable', () => {
  it('maps lost / unreachable database errors to SERVICE_UNAVAILABLE with Retry-After', () => {
    const cases: unknown[] = [
      new Prisma.PrismaClientKnownRequestError("Can't reach database server at `127.0.0.1:5432`", { code: 'P1001', clientVersion: 'x' }),
      new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: 'x' }),
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: 'x' }),
      new Prisma.PrismaClientUnknownRequestError('Error in connector: FATAL: terminating connection due to administrator command (57P01)', { clientVersion: 'x' }),
      new Prisma.PrismaClientInitializationError("Can't reach database server", 'x'),
    ];
    for (const err of cases) {
      expect(isDatabaseUnavailable(err)).toBe(true);
      const r = errorBody(err, 'req-1');
      expect(r.status).toBe(503);
      expect(r.retryAfter).toBe(5);
      expect(r.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE', retryable: true } });
    }
  });

  it('leaves request errors alone', () => {
    const unique = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' });
    expect(isDatabaseUnavailable(unique)).toBe(false);
    expect(errorBody(unique).status).toBe(409);
    expect(isDatabaseUnavailable(new Error('ECONNREFUSED'))).toBe(false);
    expect(errorBody(new Error('boom')).status).toBe(500);
  });

  it('reports values outside the database bounds (CHECK, length) as 422, not a retryable 500', () => {
    const cases: unknown[] = [
      new Prisma.PrismaClientKnownRequestError('A constraint failed on the database: `ck_chats_close_reason`', { code: 'P2004', clientVersion: 'x' }),
      new Prisma.PrismaClientKnownRequestError('The provided value for the column is too long', { code: 'P2000', clientVersion: 'x' }),
      new Prisma.PrismaClientUnknownRequestError('new row for relation "chats" violates check constraint "ck_chats_started_by" (23514)', { clientVersion: 'x' }),
      new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23514`. Message: `violates check constraint`', { code: 'P2010', clientVersion: 'x' }),
    ];
    for (const err of cases) {
      const r = errorBody(err, 'req-1');
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: { code: 'VALIDATION_FAILED', retryable: false } });
      expect(JSON.stringify(r.body)).not.toContain('ck_');
    }
  });
});

describe('StorageService outage classification (local driver)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'talkivio-storage-spec-'));
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('STORAGE_LOCAL_DIR', dir);
  });
  afterAll(async () => {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // chmod cannot lock root out of a directory, so the outage is not reproducible when the suite runs as root.
  it.skipIf(process.getuid?.() === 0)('missing objects stay null; an unreachable store raises StorageUnavailableError → 503', async () => {
    const { StorageService, StorageUnavailableError, StorageLimitError } = await import('../core/storage.service');
    const storage = new StorageService();
    await storage.write('clean', 't/a.txt', Buffer.from('hello'), 'text/plain');
    expect((await storage.read('clean', 't/a.txt', 100))?.toString()).toBe('hello');
    expect(await storage.read('clean', 't/missing.txt', 100)).toBeNull();
    await expect(storage.read('clean', 't/a.txt', 2)).rejects.toBeInstanceOf(StorageLimitError);
    await expect(storage.receive('quarantine', 't/b.bin', Readable.from([Buffer.from('abc')]), 2)).rejects.toBeInstanceOf(StorageLimitError);

    await chmod(dir, 0o000);
    try {
      for (const op of [() => storage.read('clean', 't/a.txt', 100), () => storage.stat('clean', 't/a.txt'), () => storage.openRead('clean', 't/a.txt'), () => storage.write('clean', 't/c.txt', Buffer.from('x'), 'text/plain'), () => storage.receive('quarantine', 't/d.bin', Readable.from([Buffer.from('abc')]), 3)]) {
        const err = await op().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(StorageUnavailableError);
        expect((err as Error).message).not.toContain(dir);
        expect(errorBody(err)).toMatchObject({ status: 503, retryAfter: 5, body: { error: { code: 'SERVICE_UNAVAILABLE', retryable: true } } });
      }
    } finally {
      await chmod(dir, 0o700);
    }
    expect((await storage.read('clean', 't/a.txt', 100))?.toString()).toBe('hello');
  });
});
