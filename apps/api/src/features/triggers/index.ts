/**
 * Feature module registration for "triggers". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 *
 * Trigger DSL v1 (ch. 32/33) + proactive invitations (ch. 21):
 * - TriggerEngine: outbox consumers + durable timers (worker), shared interpreter
 * - TriggerEffectsService: exactly-once effects keyed by (run, action_index)
 * - InvitationsService: invitation decisions, display ack, accept/dismiss (+ socket commands)
 * - TriggersService: REST configuration, revisions, simulation, run history
 */
import type { Provider, Type } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { TriggerEffectsService } from './trigger-effects.service';
import { TriggerEngine } from './trigger-engine.service';
import { TriggerSnapshotService } from './trigger-snapshot.service';
import { InvitationsWidgetController, TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

export const TRIGGERS_PROVIDERS: Provider[] = [TriggerSnapshotService, InvitationsService, TriggerEffectsService, TriggerEngine, TriggersService];
export const TRIGGERS_CONTROLLERS: Type<unknown>[] = [TriggersController, InvitationsWidgetController];
