import { Injectable, Logger } from '@nestjs/common';
import type { InternalEvent } from './outbox.publisher';

export type EventHandler = (event: InternalEvent) => Promise<void>;

/**
 * Registry of internal consumers for committed outbox events (webhooks, trigger
 * engine, analytics facts, notifications, email). The worker runs them; each
 * handler must be idempotent because delivery is at-least-once.
 */
@Injectable()
export class EventConsumers {
  private readonly logger = new Logger('EventConsumers');
  private readonly handlers = new Map<string, Array<{ name: string; fn: EventHandler }>>();
  private readonly wildcard: Array<{ name: string; fn: EventHandler }> = [];

  on(eventType: string | '*', name: string, fn: EventHandler): void {
    if (eventType === '*') this.wildcard.push({ name, fn });
    else this.handlers.set(eventType, [...(this.handlers.get(eventType) ?? []), { name, fn }]);
  }

  /** Runs all handlers; throws if any failed so the job retries (handlers are idempotent). */
  async dispatch(event: InternalEvent): Promise<void> {
    const list = [...(this.handlers.get(event.eventType) ?? []), ...this.wildcard];
    const failures: string[] = [];
    for (const h of list) {
      try {
        await h.fn(event);
      } catch (err) {
        failures.push(`${h.name}: ${(err as Error).message}`);
        this.logger.warn(`Consumer ${h.name} failed for ${event.eventType} ${event.eventId}: ${(err as Error).message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}
