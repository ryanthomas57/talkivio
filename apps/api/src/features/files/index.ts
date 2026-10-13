/**
 * Feature module registration for "files". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';
import { AttachmentsController, WidgetFilesController } from './files.controller';
import { FilesService } from './files.service';
import { FilesWorker } from './files.worker';

export const FILES_PROVIDERS: Provider[] = [FilesService, FilesWorker];
export const FILES_CONTROLLERS: Type<unknown>[] = [AttachmentsController, WidgetFilesController];
