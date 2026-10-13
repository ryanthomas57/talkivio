/**
 * Feature module registration for "visitors". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 *
 * Visitor monitoring (ch. 11), records/tags/custom fields (ch. 17/37/43),
 * bans (ch. 24) and identity/handoff support (ch. 25/26). The public widget
 * endpoints for identity, consent, events, handoff/redeem and SDK tags/custom
 * fields live in features/widget/widget.controller.ts and use these services.
 */
import type { Provider, Type } from '@nestjs/common';
import { BansController } from './bans.controller';
import { BansService } from './bans.service';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { IdentityHandoffService } from './identity-handoff.service';
import { IdentityTokenVerifier } from './identity-tokens';
import { PresenceReader } from './presence-reader';
import { ActiveVisitorGuard, VisitorCapabilityRevocations } from './visitor-capability';
import { VisitorMonitorService } from './visitor-monitor.service';
import { VisitorRecordsService } from './visitor-records.service';
import { VisitorsController } from './visitors.controller';

export const VISITORS_PROVIDERS: Provider[] = [
  PresenceReader,
  CustomFieldsService,
  VisitorMonitorService,
  VisitorRecordsService,
  BansService,
  IdentityTokenVerifier,
  IdentityHandoffService,
  VisitorCapabilityRevocations,
  ActiveVisitorGuard,
];
export const VISITORS_CONTROLLERS: Type<unknown>[] = [VisitorsController, CustomFieldsController, BansController];
