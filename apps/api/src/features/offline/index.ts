/**
 * Feature module registration for "offline". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';
import { OfflineSocketCommands, OfflineSubmissionsController, OfflineWidgetController } from './offline.controller';
import { OfflineNotifications } from './offline.notifications';
import { OfflineService } from './offline.service';
import { QueueOverflowService } from './queue-overflow.service';

export const OFFLINE_PROVIDERS: Provider[] = [OfflineService, OfflineNotifications, QueueOverflowService, OfflineSocketCommands];
export const OFFLINE_CONTROLLERS: Type<unknown>[] = [OfflineWidgetController, OfflineSubmissionsController];
