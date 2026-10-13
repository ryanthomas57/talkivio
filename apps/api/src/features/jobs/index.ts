/**
 * Feature module registration for "jobs" (ch. 45 `GET /jobs/{id}`): worker job status without
 * private payloads, for the job's requester or a workspace admin/owner.
 */
import type { Provider, Type } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

export const JOBS_PROVIDERS: Provider[] = [JobsService];
export const JOBS_CONTROLLERS: Type<unknown>[] = [JobsController];
