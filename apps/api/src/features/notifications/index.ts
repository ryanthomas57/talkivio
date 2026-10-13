/**
 * Feature module registration for "notifications". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 *
 * In-app agent notifications (ch. 14): outbox consumers create rows for offers,
 * forced transfers and offline submissions; REST lists/marks them; frames
 * `notification.created` / `notification.read` go to the member's agent room.
 */
import type { Provider, Type } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

export const NOTIFICATIONS_PROVIDERS: Provider[] = [NotificationsService];
export const NOTIFICATIONS_CONTROLLERS: Type<unknown>[] = [NotificationsController];
