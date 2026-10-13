/**
 * Feature module registration for "tenant-deletion" (ch. 41 `POST /tenants/current/deletion-requests`):
 * owner requests with a cancellation window and transcript archive, and the worker's staged destruction.
 */
import type { Provider, Type } from '@nestjs/common';
import { TenantDeletionController } from './tenant-deletion.controller';
import { TenantDeletionService } from './tenant-deletion.service';
import { TenantDestroyer } from './tenant-destroyer';

export const TENANT_DELETION_PROVIDERS: Provider[] = [TenantDestroyer, TenantDeletionService];
export const TENANT_DELETION_CONTROLLERS: Type<unknown>[] = [TenantDeletionController];
