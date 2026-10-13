'use client';
/**
 * Attachments (ch. 19): uploads use a short-lived signed target issued by the API
 * (S3 presigned PUT or the local single-use `…/content?sig=` route), are finalized
 * with their SHA-256, then stay unavailable until the malware scan reports clean.
 * Downloads go through a 60-second grant re-checked on every request; object keys
 * never reach the client.
 */
import { toast } from 'sonner';
import { tStatic } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { realtime } from '@/lib/realtime';

export interface AttachmentView {
  id: string;
  chatId: string;
  name: string;
  sizeBytes: number;
  mime: string;
  state: 'initiated' | 'uploading' | 'uploaded' | 'scanning' | 'clean' | 'rejected' | 'expired';
  isImage: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

interface UploadTicket {
  uploadId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
  attachment: AttachmentView;
}

/** API-hosted grants are fetched through the dashboard's same-origin proxy. */
function sameOriginIfApi(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (u.pathname.startsWith('/api/v1/')) return `${u.pathname}${u.search}`;
    return u.toString();
  } catch {
    return url;
  }
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Upload one file for a chat and return the attachment once it is finalized (scan pending). */
export async function uploadAttachment(chatId: string, file: File, onProgress?: (fraction: number) => void): Promise<AttachmentView> {
  const sha256 = await sha256Hex(file);
  const ticket = await api.post<UploadTicket>('/attachments/uploads', { chatId, name: file.name, sizeBytes: file.size, mime: file.type || '', sha256 });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const target = sameOriginIfApi(ticket.url);
    xhr.open(ticket.method, target);
    // The signature is the credential. Cross-origin (S3) uploads carry no cookies; a
    // same-origin proxied upload sends the session cookie, so it must carry the CSRF token.
    xhr.withCredentials = false;
    if (target.startsWith('/')) {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('rd_csrf='));
      if (csrf) xhr.setRequestHeader('x-csrf-token', decodeURIComponent(csrf.slice('rd_csrf='.length)));
    }
    for (const [k, v] of Object.entries(ticket.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError({ status: xhr.status, code: 'UPLOAD_FAILED', message: tStatic('inbox.attachments.uploadRejected') })));
    xhr.onerror = () => reject(new ApiError({ status: 0, code: 'NETWORK', message: tStatic('inbox.attachments.uploadInterrupted'), retryable: true }));
    xhr.send(file);
  });
  await api.post(`/attachments/${ticket.uploadId}/finalize`, { sha256 });
  return { ...ticket.attachment, state: 'scanning' };
}

/** Resolve when the scan settles (clean / rejected / expired), using events with a polling fallback. */
export function waitForScan(id: string, timeoutMs = 120_000): { promise: Promise<AttachmentView>; cancel: () => void } {
  let done = false;
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const cancel = () => {
    done = true;
    off?.();
    if (timer) clearInterval(timer);
  };
  const promise = new Promise<AttachmentView>((resolve, reject) => {
    const settle = (a: AttachmentView) => {
      if (done || !['clean', 'rejected', 'expired'].includes(a.state)) return;
      cancel();
      resolve(a);
    };
    const check = () =>
      api
        .get<AttachmentView>(`/attachments/${id}`)
        .then(settle)
        .catch(() => undefined);
    off = realtime.on<{ attachmentId: string; state: AttachmentView['state'] }>('attachment.updated', (e) => {
      if (e.payload.attachmentId === id) void check();
    });
    const started = Date.now();
    timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        cancel();
        reject(new ApiError({ status: 0, code: 'FILE_SCAN_PENDING', message: tStatic('inbox.attachments.scanSlow'), retryable: true }));
        return;
      }
      void check();
    }, 3000);
    void check();
  });
  return { promise, cancel };
}

export async function cancelUpload(id: string): Promise<void> {
  await api.delete(`/attachments/${id}`).catch(() => undefined);
}

export async function openAttachment(id: string): Promise<void> {
  try {
    const grant = await api.get<{ url: string; expiresAt: string }>(`/attachments/${id}/download`);
    const a = document.createElement('a');
    a.href = sameOriginIfApi(grant.url);
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast.error(tStatic('inbox.attachments.downloadFailed', { error: errorMessage(e) }));
  }
}
