import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { hmacSha256, safeEqual } from '../common/crypto';

/**
 * Private object storage (ch. 19/20).
 *
 * Logical areas:
 *  - `quarantine`: untrusted uploads before a clean scan. Never served.
 *  - `clean`: scanned attachment bytes (served only through short download grants).
 *  - `exports`: transcript/export artifacts (served only through short download grants).
 *
 * Drivers share one interface:
 *  - `s3`: any S3-compatible store. Uploads use presigned PUT URLs that sign the exact
 *    content type and content length (and SHA-256 when declared) and expire in minutes;
 *    downloads use presigned GET URLs with `Content-Disposition: attachment`, or stream
 *    through the API (`S3_DOWNLOAD_MODE=proxy`) to add nosniff/CSP headers.
 *  - `local` (development): the API emulates the same flow with HMAC-signed, expiring
 *    URLs on API routes (`?sig=`), storing bytes under `STORAGE_LOCAL_DIR/<area>/`.
 *
 * Object keys are generated server-side and no API field returns them. The one place a client sees
 * a key is the path of an S3 presigned upload URL, which names its single quarantine object and only
 * allows a PUT of the declared bytes for a few minutes.
 */
export type StorageArea = 'quarantine' | 'clean' | 'exports';

export type GrantKind = 'upload' | 'download';

/** Claims carried by a local (API-served) signed URL. */
export interface GrantClaims {
  /** tenant id */
  t: string;
  /** resource id (attachment or export id) */
  r: string;
  k: GrantKind;
  /** route scope, e.g. `attachment:agent`, `attachment:widget`, `export:agent` */
  s: string;
  /** hash of the bound object key (a grant never outlives a key change) */
  h: string;
  exp: number;
  n: string;
}

export interface GrantTarget {
  tenantId: string;
  resourceId: string;
  scope: string;
  /** API path (without query) that serves this grant in local/proxy mode, e.g. `/api/v1/attachments/<id>/content`. */
  path: string;
}

export interface UploadTicket {
  url: string;
  method: 'PUT';
  /** Headers the client must send verbatim (lower-case names). Content-Length is enforced (browsers set it from the body). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadGrant {
  url: string;
  method: 'GET';
  expiresAt: Date;
}

export class StorageLimitError extends Error {
  constructor(
    readonly reason: 'too_large' | 'incomplete',
    readonly received: number,
  ) {
    super(
      reason === 'too_large' ? 'Upload exceeded the declared size' : 'Upload ended before the declared size',
    );
  }
}

/**
 * The object store could not complete an operation (unreachable, refused, timed out) — as opposed to a missing
 * object or a size limit. Mapped to 503 SERVICE_UNAVAILABLE (retryable); worker jobs retry. The message carries the
 * error code only, never object keys or paths.
 */
export class StorageUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    const c = cause as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: number } };
    const reason =
      typeof c?.code === 'string'
        ? c.code
        : c?.$metadata?.httpStatusCode
          ? `HTTP ${c.$metadata.httpStatusCode}`
          : typeof c?.name === 'string'
            ? c.name
            : 'unknown error';
    super(`Object storage unavailable (${operation}: ${reason})`);
    this.name = 'StorageUnavailableError';
  }
}

class StorageKeyError extends Error {}

/** Re-throws limit / key / already-classified errors as they are; anything else means the store is unavailable. */
function unavailable(operation: string, err: unknown): never {
  if (
    err instanceof StorageLimitError ||
    err instanceof StorageUnavailableError ||
    err instanceof StorageKeyError
  )
    throw err;
  throw new StorageUnavailableError(operation, err);
}

const GRANT_PREFIX = 'rdg1';

function grantKey(): string {
  return `storage-grant:${env().APP_SECRET}`;
}

/** RFC 6266 / RFC 5987 `attachment` disposition with an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim() || 'download';
  const ascii = cleaned.replace(/[^\w.\- ]/g, '_').slice(0, 150) || 'download';
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Short stable fingerprint of an object key (bound into grants; never reveals the key). */
export function keyHash(key: string): string {
  return createHash('sha256').update(`objkey:${key}`).digest('base64url').slice(0, 22);
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.code === 'ENOENT' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  private s3: S3Client | null = null;
  private s3Presign: S3Client | null = null;

  get driver(): 'local' | 's3' {
    return env().STORAGE_DRIVER;
  }

  /** True when downloads are streamed by the API (local driver or S3 proxy mode). */
  get proxiesDownloads(): boolean {
    return this.driver === 'local' || env().S3_DOWNLOAD_MODE === 'proxy';
  }

  // ───────────────────────── Signed API grants (local driver / proxy mode) ─────────────────────────

  signGrant(
    target: GrantTarget,
    kind: GrantKind,
    objectKey: string,
    ttlSeconds: number,
  ): { token: string; url: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds));
    const claims: GrantClaims = {
      t: target.tenantId,
      r: target.resourceId,
      k: kind,
      s: target.scope,
      h: keyHash(objectKey),
      exp,
      n: randomBytes(9).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${GRANT_PREFIX}.${body}.${hmacSha256(grantKey(), body, 'base64url')}`;
    const url = `${env().API_URL.replace(/\/$/, '')}${target.path}?sig=${encodeURIComponent(token)}`;
    return { token, url, expiresAt: new Date(exp * 1000) };
  }

  /** Verifies signature, expiry, kind, scope and resource binding. Returns claims or null (never throws). */
  verifyGrant(
    token: string | undefined | null,
    expect: { kind: GrantKind; resourceId: string; scope: string },
  ): GrantClaims | null {
    if (!token || token.length > 2048 || !token.startsWith(`${GRANT_PREFIX}.`)) return null;
    const [, body, sig] = token.split('.');
    if (!body || !sig || !safeEqual(hmacSha256(grantKey(), body, 'base64url'), sig)) return null;
    try {
      const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GrantClaims;
      if (typeof c.exp !== 'number' || c.exp < Math.floor(Date.now() / 1000)) return null;
      if (c.k !== expect.kind || c.r !== expect.resourceId || c.s !== expect.scope) return null;
      return c;
    } catch {
      return null;
    }
  }

  // ───────────────────────── Presigned URLs ─────────────────────────

  async presignUpload(input: {
    area: StorageArea;
    key: string;
    contentType: string;
    contentLength: number;
    sha256Hex?: string | null;
    ttlSeconds: number;
    grant: GrantTarget;
  }): Promise<UploadTicket> {
    if (this.driver === 's3') {
      const checksum = input.sha256Hex ? Buffer.from(input.sha256Hex, 'hex').toString('base64') : undefined;
      const cmd = new PutObjectCommand({
        Bucket: this.bucket(input.area),
        Key: this.objectName(input.area, input.key),
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        ...(checksum ? { ChecksumSHA256: checksum } : {}),
      });
      const url = await getSignedUrl(this.presignClient(), cmd, {
        expiresIn: input.ttlSeconds,
        signableHeaders: new Set([
          'content-type',
          'content-length',
          ...(checksum ? ['x-amz-checksum-sha256'] : []),
        ]),
        unhoistableHeaders: new Set(checksum ? ['x-amz-checksum-sha256'] : []),
      });
      return {
        url,
        method: 'PUT',
        headers: {
          'content-type': input.contentType,
          ...(checksum ? { 'x-amz-checksum-sha256': checksum } : {}),
        },
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
      };
    }
    const g = this.signGrant(input.grant, 'upload', input.key, input.ttlSeconds);
    return {
      url: g.url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: g.expiresAt,
    };
  }

  async presignDownload(input: {
    area: StorageArea;
    key: string;
    filename: string;
    contentType: string;
    ttlSeconds: number;
    grant: GrantTarget;
  }): Promise<DownloadGrant> {
    if (!this.proxiesDownloads) {
      const cmd = new GetObjectCommand({
        Bucket: this.bucket(input.area),
        Key: this.objectName(input.area, input.key),
        ResponseContentDisposition: contentDisposition(input.filename),
        ResponseContentType: input.contentType,
        ResponseCacheControl: 'private, no-store, max-age=0',
      });
      const url = await getSignedUrl(this.presignClient(), cmd, { expiresIn: input.ttlSeconds });
      return { url, method: 'GET', expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
    }
    const g = this.signGrant(input.grant, 'download', input.key, input.ttlSeconds);
    return { url: g.url, method: 'GET', expiresAt: g.expiresAt };
  }

  // ───────────────────────── Object operations ─────────────────────────

  /**
   * Local driver only: receive an upload body, enforcing the exact declared size while
   * streaming (aborts as soon as the body exceeds it). Atomic rename on success.
   */
  async receive(
    area: StorageArea,
    key: string,
    source: Readable,
    expectedBytes: number,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    if (this.driver !== 'local')
      throw new Error('Direct uploads are only accepted by the local storage driver');
    const final = this.localPath(area, key);
    await mkdir(dirname(final), { recursive: true }).catch((err) => unavailable('receive', err));
    const temp = `${final}.part-${randomBytes(6).toString('hex')}`;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expectedBytes) return cb(new StorageLimitError('too_large', received));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (received !== expectedBytes) throw new StorageLimitError('incomplete', received);
      await rename(temp, final);
      return { sizeBytes: received, sha256: hash.digest('hex') };
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      if (err instanceof StorageLimitError) throw err;
      if (
        (err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        (err as NodeJS.ErrnoException).code === 'ECONNRESET'
      ) {
        throw new StorageLimitError('incomplete', received);
      }
      unavailable('receive', err);
    }
  }

  async stat(area: StorageArea, key: string): Promise<{ sizeBytes: number } | null> {
    try {
      if (this.driver === 's3') {
        const r = await this.client().send(
          new HeadObjectCommand({ Bucket: this.bucket(area), Key: this.objectName(area, key) }),
        );
        return { sizeBytes: Number(r.ContentLength ?? 0) };
      }
      const s = await stat(this.localPath(area, key));
      return s.isFile() ? { sizeBytes: s.size } : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      unavailable('stat', err);
    }
  }

  /** Reads a whole object, refusing objects larger than `maxBytes`. Returns null when missing. */
  async read(area: StorageArea, key: string, maxBytes: number): Promise<Buffer | null> {
    try {
      if (this.driver === 's3') {
        const r = await this.client().send(
          new GetObjectCommand({ Bucket: this.bucket(area), Key: this.objectName(area, key) }),
        );
        if (Number(r.ContentLength ?? 0) > maxBytes) {
          (r.Body as Readable | undefined)?.destroy?.();
          throw new StorageLimitError('too_large', Number(r.ContentLength));
        }
        return Buffer.from(await r.Body!.transformToByteArray());
      }
      const path = this.localPath(area, key);
      const fh = await open(path, 'r');
      try {
        const { size } = await fh.stat();
        if (size > maxBytes) throw new StorageLimitError('too_large', size);
        const buf = Buffer.alloc(size);
        let off = 0;
        while (off < size) {
          const { bytesRead } = await fh.read(buf, off, size - off, off);
          if (!bytesRead) break;
          off += bytesRead;
        }
        return off === size ? buf : buf.subarray(0, off);
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (isNotFound(err)) return null;
      unavailable('read', err);
    }
  }

  /** Stream an object (API-proxied downloads). Returns null when missing. */
  async openRead(area: StorageArea, key: string): Promise<{ stream: Readable; sizeBytes: number } | null> {
    try {
      if (this.driver === 's3') {
        const r = await this.client().send(
          new GetObjectCommand({ Bucket: this.bucket(area), Key: this.objectName(area, key) }),
        );
        return { stream: r.Body as Readable, sizeBytes: Number(r.ContentLength ?? 0) };
      }
      const path = this.localPath(area, key);
      const s = await stat(path);
      return { stream: createReadStream(path), sizeBytes: s.size };
    } catch (err) {
      if (isNotFound(err)) return null;
      unavailable('openRead', err);
    }
  }

  async write(area: StorageArea, key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.writeObject(area, key, body, contentType);
    } catch (err) {
      unavailable('write', err);
    }
  }

  private async writeObject(
    area: StorageArea,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    if (this.driver === 's3') {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.bucket(area),
          Key: this.objectName(area, key),
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        }),
      );
      return;
    }
    const final = this.localPath(area, key);
    await mkdir(dirname(final), { recursive: true });
    const temp = `${final}.part-${randomBytes(6).toString('hex')}`;
    const fh = await open(temp, 'wx', 0o600);
    try {
      await fh.writeFile(body);
    } finally {
      await fh.close();
    }
    await rename(temp, final);
  }

  /** Idempotent delete (missing objects are fine). */
  async delete(area: StorageArea, key: string): Promise<void> {
    try {
      if (this.driver === 's3')
        await this.client().send(
          new DeleteObjectCommand({ Bucket: this.bucket(area), Key: this.objectName(area, key) }),
        );
      else await rm(this.localPath(area, key), { force: true });
    } catch (err) {
      if (isNotFound(err)) return;
      this.logger.warn(`Failed to delete ${area} object: ${(err as Error).message}`);
      unavailable('delete', err);
    }
  }

  // ───────────────────────── Legacy helpers (clean area) ─────────────────────────

  /** Store server-generated content in the clean area. */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.write('clean', key, body, contentType);
  }

  /** Stream (local) or short presigned redirect (S3) for a clean-area object, always as an attachment. */
  async get(key: string, filename: string): Promise<{ stream?: Readable; redirect?: string }> {
    if (this.driver === 's3') {
      const url = await getSignedUrl(
        this.presignClient(),
        new GetObjectCommand({
          Bucket: this.bucket('clean'),
          Key: this.objectName('clean', key),
          ResponseContentDisposition: contentDisposition(filename),
        }),
        { expiresIn: 60 },
      );
      return { redirect: url };
    }
    const r = await this.openRead('clean', key);
    if (!r) throw new Error('File missing');
    return { stream: r.stream };
  }

  async remove(key: string): Promise<void> {
    await this.delete('clean', key).catch(() => undefined);
  }

  // ───────────────────────── Internals ─────────────────────────

  private bucket(area: StorageArea): string {
    const e = env();
    const b =
      area === 'quarantine' ? (e.S3_QUARANTINE_BUCKET ?? e.S3_BUCKET) : (e.S3_CLEAN_BUCKET ?? e.S3_BUCKET);
    if (!b) throw new Error(`No S3 bucket configured for the ${area} area`);
    return b;
  }

  private objectName(area: StorageArea, key: string): string {
    const e = env();
    const prefix =
      area === 'quarantine'
        ? e.S3_QUARANTINE_PREFIX
        : area === 'exports'
          ? e.S3_EXPORTS_PREFIX
          : e.S3_CLEAN_PREFIX;
    return `${prefix}${key}`;
  }

  private localPath(area: StorageArea, key: string): string {
    const base = resolve(process.cwd(), env().STORAGE_LOCAL_DIR, area);
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new StorageKeyError('Invalid storage key');
    return full;
  }

  private makeClient(endpoint: string | undefined): S3Client {
    const e = env();
    return new S3Client({
      region: e.S3_REGION,
      endpoint,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: e.S3_ACCESS_KEY_ID
        ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? '' }
        : undefined,
      // Presigned PUTs must not carry an SDK-computed checksum of an empty body.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private client(): S3Client {
    this.s3 ??= this.makeClient(env().S3_ENDPOINT);
    return this.s3;
  }

  private presignClient(): S3Client {
    const e = env();
    if (!e.S3_PRESIGN_ENDPOINT) return this.client();
    this.s3Presign ??= this.makeClient(e.S3_PRESIGN_ENDPOINT);
    return this.s3Presign;
  }
}
