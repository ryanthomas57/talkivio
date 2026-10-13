/**
 * Feature module registration for "privacy" (ch. 53/54): privacy requests (access
 * export and erasure), tombstone ledger and replay, retention, audit administration.
 */
import type { Provider, Type } from '@nestjs/common';
import { AccessExportService } from './access-export.service';
import { AuditEventsController } from './audit-events.controller';
import { AuditEventsService } from './audit-events.service';
import { ErasureService } from './erasure.service';
import { PrivacyObjectStore } from './object-store';
import { PrivacyJobRunner } from './privacy-jobs';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { RetentionService } from './retention.service';
import { TombstoneService } from './tombstones.service';

export const PRIVACY_PROVIDERS: Provider[] = [
  PrivacyObjectStore,
  ErasureService,
  AccessExportService,
  TombstoneService,
  RetentionService,
  PrivacyService,
  PrivacyJobRunner,
  AuditEventsService,
];
export const PRIVACY_CONTROLLERS: Type<unknown>[] = [PrivacyController, AuditEventsController];
