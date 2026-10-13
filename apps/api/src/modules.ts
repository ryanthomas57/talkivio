import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TenantDb } from './db/tenant-db';
import { RedisService } from './common/redis.service';
import { AuditService } from './common/audit.service';
import { EnvelopeInterceptor, GlobalExceptionFilter } from './common/http';
import { IdempotencyService } from './common/idempotency';
import { GeoService } from './core/geo.service';
import { MailService } from './core/mail.service';
import { PresenceService } from './core/presence.service';
import { QueueService } from './core/queue.service';
import { RateLimitService } from './core/rate-limit.service';
import { StorageService } from './core/storage.service';
import { OutboxService } from './outbox/outbox.service';
import { OutboxPublisher } from './outbox/outbox.publisher';
import { EventConsumers } from './outbox/event-consumers';
import { RealtimeService } from './realtime/realtime.service';
import { TicketsService } from './realtime/tickets.service';
import { CommandRegistry } from './realtime/command-registry';
import { ScopeAuthorizer } from './realtime/scope-authorizer';
import { AgentGateway, VisitorGateway } from './realtime/gateway';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { OAuthService } from './auth/oauth.service';
import { SessionService } from './auth/session.service';
import { AuthController, TenantSwitchController } from './auth/auth.controller';
import { RealtimeController } from './realtime/realtime.controller';
import { AvailabilityService } from './features/availability/availability.service';
import { AvailabilityBroadcaster } from './features/availability/availability.broadcaster';
import { ChatStore } from './features/chats/chat.store';
import { RoutingService } from './features/chats/routing.service';
import { ChatCommandsService } from './features/chats/chat-commands.service';
import { ChatQueriesService } from './features/chats/chat-queries.service';
import { ChatSocketCommands } from './features/chats/chat-socket.commands';
import { ChatsController, OffersController } from './features/chats/chats.controller';
import { WidgetService } from './features/widget/widget.service';
import { WidgetController, WidgetFrameController } from './features/widget/widget.controller';
import { TeamService } from './features/workspace/team.service';
import { SitesService } from './features/workspace/sites.service';
import { AgentsController, DepartmentsController, SitesController, TagsController, TenantController } from './features/workspace/workspace.controller';
import { HealthController } from './health.controller';
import { MetricsService } from './core/metrics.service';
import { WorkerService } from './worker/worker.service';
import { FEATURE_CONTROLLERS, FEATURE_PROVIDERS } from './features/registry';
import { QueueBroadcaster } from './features/chats/queue-broadcaster.service';
import { TeamSocketCommands } from './features/workspace/team-socket.commands';

/** Visitor connection lifecycle → chat reconnection grace (ch. 16). */
@Injectable()
export class ChatPresenceHooks implements OnModuleInit {
  constructor(
    private readonly presence: PresenceService,
    private readonly chats: ChatCommandsService,
  ) {}

  onModuleInit(): void {
    this.presence.onVisitorConnection(async (tenantId, visitorId, _sessionId, event) => {
      if (event === 'connected') await this.chats.visitorReconnected(tenantId, visitorId);
      else await this.chats.visitorDisconnected(tenantId, visitorId);
    });
  }
}

const core = [
  TenantDb,
  MetricsService,
  RedisService,
  AuditService,
  IdempotencyService,
  RealtimeService,
  QueueService,
  MailService,
  StorageService,
  GeoService,
  PresenceService,
  RateLimitService,
  OutboxService,
  EventConsumers,
  TicketsService,
  CommandRegistry,
];

const domain = [
  SessionService,
  AuthService,
  OAuthService,
  AuthGuard,
  ScopeAuthorizer,
  AvailabilityService,
  AvailabilityBroadcaster,
  ChatStore,
  RoutingService,
  QueueBroadcaster,
  ChatCommandsService,
  ChatQueriesService,
  ChatSocketCommands,
  ChatPresenceHooks,
  WidgetService,
  TeamService,
  TeamSocketCommands,
  SitesService,
  OutboxPublisher,
  WorkerService,
  ...FEATURE_PROVIDERS,
];

@Global()
@Module({ providers: core, exports: core })
export class CoreModule {}

@Module({ imports: [CoreModule], providers: domain, exports: domain })
export class DomainModule {}

const httpControllers = [
  AuthController,
  TenantSwitchController,
  RealtimeController,
  TenantController,
  AgentsController,
  DepartmentsController,
  SitesController,
  TagsController,
  ChatsController,
  OffersController,
  WidgetController,
  WidgetFrameController,
  HealthController,
  ...FEATURE_CONTROLLERS,
];

const httpProviders = [
  { provide: APP_GUARD, useClass: AuthGuard },
  { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
];

/** REST API (+ realtime gateway unless GATEWAY_SEPARATE=true). */
@Module({
  imports: [CoreModule, DomainModule],
  controllers: httpControllers,
  providers: [...httpProviders, ...(process.env.GATEWAY_SEPARATE === 'true' ? [] : [AgentGateway, VisitorGateway])],
})
export class ApiModule {}

/** Realtime gateway process (independently scalable). */
@Module({
  imports: [CoreModule, DomainModule],
  controllers: [HealthController],
  providers: [AgentGateway, VisitorGateway, { provide: APP_FILTER, useClass: GlobalExceptionFilter }],
})
export class GatewayModule {}

/** Background worker process. */
@Module({ imports: [CoreModule, DomainModule] })
export class WorkerModule {}
