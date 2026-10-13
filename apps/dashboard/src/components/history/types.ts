/** History, export and transcript-email shapes (mirror chats + exports features in apps/api). */
import type { MessageKey } from '@/i18n';
import type { StaffChat } from '@/lib/types';

/** `snippet` is plain text; `snippetHighlights` are [start, end) code-point offsets of search matches. */
export type HistoryChat = StaffChat & { snippet?: string | null; snippetHighlights?: Array<[number, number]> };

export type ExportFormat = 'txt' | 'json' | 'csv' | 'pdf';
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportJob {
  id: string;
  state: ExportState;
  format: ExportFormat;
  timezone: string;
  includeInternal: boolean;
  progress: number;
  itemCount: number | null;
  sizeBytes: number | null;
  sha256: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export interface ExportPreview {
  count: number;
  limit: number;
  maxRangeDays: number;
  allowed?: boolean;
  reason?: 'too_many_chats' | 'no_chats';
}

export interface DownloadGrant {
  url: string;
  method: string;
  expiresAt: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface ExportFilters {
  from: string;
  to: string;
  siteId?: string;
  departmentId?: string;
  agentId?: string;
  status?: 'active' | 'closed' | 'queued';
  rating?: 'good' | 'bad' | 'none';
  tagId?: string;
}

export type TranscriptEmailState = 'queued' | 'rendering' | 'sending' | 'accepted' | 'delivered' | 'retrying' | 'failed';

export interface TranscriptEmailJob {
  id: string;
  chatId: string;
  state: TranscriptEmailState;
  format: 'txt' | 'pdf';
  recipientKind: 'visitor' | 'self';
  includeInternal: boolean;
  acceptedAt: string | null;
  deliveredAt: string | null;
  duplicate: boolean;
  createdAt: string;
}

/** Message keys: render with t(FORMAT_LABEL[format]). */
export const FORMAT_LABEL: Record<ExportFormat, MessageKey> = {
  txt: 'history.format.txt',
  json: 'history.format.json',
  csv: 'history.format.csv',
  pdf: 'history.format.pdf',
};

export const historyKeys = {
  list: (q: string) => ['history', 'list', q] as const,
  chat: (id: string) => ['history', 'chat', id] as const,
  messages: (id: string) => ['history', 'messages', id] as const,
  exports: ['exports'] as const,
  export: (id: string) => ['exports', id] as const,
};
