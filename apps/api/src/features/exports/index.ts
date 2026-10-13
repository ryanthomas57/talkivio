/**
 * Feature module registration for "exports". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';
import { ExportsController, TranscriptEmailController, WidgetExportsController } from './exports.controller';
import { ExportJobsQueue, ExportsService } from './exports.service';
import { ExportsWorker } from './exports.worker';

export const EXPORTS_PROVIDERS: Provider[] = [ExportJobsQueue, ExportsService, ExportsWorker];
export const EXPORTS_CONTROLLERS: Type<unknown>[] = [ExportsController, TranscriptEmailController, WidgetExportsController];
