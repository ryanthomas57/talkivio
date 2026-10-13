/**
 * Feature module registration for "schedules". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';
import { ScheduleTimers } from './schedule-timers';
import { EmergencyClosuresController, SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

export const SCHEDULES_PROVIDERS: Provider[] = [ScheduleTimers, SchedulesService];
export const SCHEDULES_CONTROLLERS: Type<unknown>[] = [SchedulesController, EmergencyClosuresController];
