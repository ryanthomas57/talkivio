import { Injectable } from '@nestjs/common';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../../config/env';
import { StorageService, type StorageArea } from '../../core/storage.service';

/**
 * Object-store operations the privacy workflows need on top of StorageService:
 * confirmed removal (delete, then verify absence with stat), and prefix listing
 * for the erasure ledger (StorageService has no list operation).
 */
@Injectable()
export class PrivacyObjectStore {
  private s3: S3Client | null = null;
  constructor(private readonly storage: StorageService) {}

  write(area: StorageArea, key: string, body: Buffer, contentType: string): Promise<void> {
    return this.storage.write(area, key, body, contentType);
  }

  read(area: StorageArea, key: string, maxBytes: number): Promise<Buffer | null> {
    return this.storage.read(area, key, maxBytes);
  }

  openRead(area: StorageArea, key: string): Promise<{ stream: Readable; sizeBytes: number } | null> {
    return this.storage.openRead(area, key);
  }

  async exists(area: StorageArea, key: string): Promise<boolean> {
    return (await this.storage.stat(area, key)) !== null;
  }

  /** Delete from every listed area and confirm absence. False when any copy remains or the store failed. */
  async removeConfirmed(key: string, areas: StorageArea[]): Promise<boolean> {
    let ok = true;
    for (const area of areas) {
      try {
        await this.storage.delete(area, key);
        if (await this.exists(area, key)) ok = false;
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /** List keys under a prefix within an area (keys are relative to the area, like StorageService keys). */
  async list(area: StorageArea, prefix: string): Promise<string[]> {
    const e = env();
    if (e.STORAGE_DRIVER === 's3') {
      this.s3 ??= new S3Client({
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
        credentials: e.S3_ACCESS_KEY_ID
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? '' }
          : undefined,
      });
      const bucket =
        area === 'quarantine' ? (e.S3_QUARANTINE_BUCKET ?? e.S3_BUCKET) : (e.S3_CLEAN_BUCKET ?? e.S3_BUCKET);
      const areaPrefix =
        area === 'quarantine'
          ? e.S3_QUARANTINE_PREFIX
          : area === 'exports'
            ? e.S3_EXPORTS_PREFIX
            : e.S3_CLEAN_PREFIX;
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${areaPrefix}${prefix}`,
            ContinuationToken: token,
          }),
        );
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key.slice(areaPrefix.length));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    }
    const base = resolve(process.cwd(), e.STORAGE_LOCAL_DIR, area);
    const root = resolve(base, prefix.replace(/\/$/, ''));
    if (!root.startsWith(base + sep) || !existsSync(root)) return [];
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!entry.name.includes('.part-') && !entry.name.startsWith('.'))
          out.push(relative(base, full).split(sep).join('/'));
      }
    };
    await walk(root);
    return out.sort();
  }
}
