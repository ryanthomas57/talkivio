/**
 * Visitor uploads (API v2): `POST /widget/v1/uploads` reserves a slot and returns a
 * signed PUT target; the bytes go there directly (no cookies), then the controller
 * finalizes with the SHA-256 and waits for the malware scan to mark the file `clean`.
 *
 * With the local storage driver the PUT target is on the API origin (covered by the frame
 * CSP `connect-src 'self'`). An S3 / CDN target is another origin and must be added to the
 * frame CSP `connect-src` by the API.
 */

/** Hex SHA-256 of a file (Web Crypto; requires a secure context, i.e. https or localhost). */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PutHandle {
  promise: Promise<void>;
  abort(): void;
}

/** PUT the bytes to the signed target with progress. Rejects with an error code. */
export function putBytes(url: string, method: string, headers: Record<string, string>, file: Blob, onProgress: (fraction: number) => void): PutHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    xhr.open(method || 'PUT', url);
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(headers)) {
      // Browsers set Content-Length themselves (and refuse to let scripts set it).
      if (k.toLowerCase() !== 'content-length') xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.min(1, e.loaded / e.total));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let code = xhr.status === 413 ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED';
      try {
        code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code || code;
      } catch {
        /* storage providers answer in XML / plain text */
      }
      reject(new Error(code));
    };
    xhr.onerror = () => reject(new Error('UPLOAD_FAILED'));
    xhr.onabort = () => reject(new Error('ABORTED'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export function isPreviewableImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
}
