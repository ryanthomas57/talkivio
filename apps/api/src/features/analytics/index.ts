/**
 * Feature module registration for "analytics". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 *
 * Analytics (ch. 49–51): chat facts consumer, reports, CSV exports and the
 * supervisor monitor (REST snapshot + coalesced `monitor.updated` pushes to the
 * watching supervisor's own agent room).
 */
import type { Provider, Type } from '@nestjs/common';
import { AnalyticsController, MonitorController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsExportService } from './export.service';
import { FactLoader } from './fact-loader';
import { FactsService } from './facts.service';
import { MonitorService } from './monitor.service';

export const ANALYTICS_PROVIDERS: Provider[] = [FactLoader, FactsService, AnalyticsService, AnalyticsExportService, MonitorService];
export const ANALYTICS_CONTROLLERS: Type<unknown>[] = [AnalyticsController, MonitorController];
