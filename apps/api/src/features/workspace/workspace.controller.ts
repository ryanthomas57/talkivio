import { lockForUpdate } from '../../db/row-lock';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { hasFallbackCycle, isValidTimezone, mergeOrgSettings, orgSettingsPatchSchema, type OrgSettings } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import {
  AllowPendingMfa,
  Auth,
  body,
  conflict,
  CurrentUser,
  notFound,
  Public,
  RecentAuth,
  Require,
  TokenAccess,
  UserScoped,
  type AppRequest,
  type AuthContext,
  type UserContext,
} from '../../common/http';
import { AvailabilityBroadcaster } from '../availability/availability.broadcaster';
import { SitesService } from './sites.service';
import { TeamService } from './team.service';

const uuid = z.string().uuid();
const roleEnum = z.enum(['admin', 'supervisor', 'agent', 'analyst']);

// ═════════════════════════════ Tenant ═════════════════════════════

const tenantPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    settings: orgSettingsPatchSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
const onboardingSchema = z.object({ step: z.string().max(40).optional(), data: z.record(z.unknown()).optional(), completed: z.boolean().optional() }).strict();

@Controller('tenants/current')
export class TenantController {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly broadcaster: AvailabilityBroadcaster,
    private readonly team: TeamService,
  ) {}

  private async resource(tenantId: string) {
    const t = await this.db.read(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      timezone: t.timezone,
      status: t.status,
      plan: t.plan,
      retentionDays: t.retentionDays,
      settings: mergeOrgSettings(t.settings),
      onboardingState: t.onboardingState as Record<string, unknown>,
      onboardingCompleted: !!t.onboardingCompletedAt,
      version: t.version,
      createdAt: t.createdAt,
    };
  }

  @Get()
  @AllowPendingMfa()
  @TokenAccess()
  current(@Auth() auth: AuthContext) {
    return this.resource(auth.tenantId);
  }

  @Patch()
  @Require('tenant.manage')
  async update(@Auth() auth: AuthContext, @Body(body(tenantPatchSchema)) input: z.infer<typeof tenantPatchSchema>) {
    await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'tenants', auth.tenantId, auth.tenantId);
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      if (input.expectedVersion && input.expectedVersion !== t.version) throw conflict('VERSION_CONFLICT', 'Settings were changed by someone else. Reload to continue.');
      const current = mergeOrgSettings(t.settings);
      const patch = input.settings ?? {};
      const next: OrgSettings = {
        routing: { ...current.routing, ...(patch.routing ?? {}) },
        chat: { ...current.chat, ...(patch.chat ?? {}) },
        operatingHours: patch.operatingHours ?? current.operatingHours,
        security: { ...current.security, ...(patch.security ?? {}) },
        notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
        locale: { ...current.locale, ...(patch.locale ?? {}) },
        tracking: { ...current.tracking, ...(patch.tracking ?? {}) },
        availability: { ...current.availability, ...(patch.availability ?? {}) },
        offline: { ...current.offline, ...(patch.offline ?? {}) },
        analytics: { ...current.analytics, ...(patch.analytics ?? {}) },
        files: { ...current.files, ...(patch.files ?? {}) },
      };
      if (next.availability.defaultScheduleId && !(await tx.schedule.findFirst({ where: { tenantId: auth.tenantId, id: next.availability.defaultScheduleId } }))) throw notFound('Schedule');
      await tx.tenant.update({
        where: { id: auth.tenantId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.retentionDays ? { retentionDays: input.retentionDays } : {}),
          settings: { ...(t.settings as object), ...next } as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      await this.audit.inTx(tx, auth, {
        action: patch.security ? 'tenant.security_updated' : 'tenant.settings_updated',
        objectType: 'tenant',
        objectId: auth.tenantId,
        safeDiff: { sections: Object.keys(patch), name: input.name, timezone: input.timezone, retention_days: input.retentionDays },
      });
    });
    this.broadcaster.schedule(auth.tenantId);
    return this.resource(auth.tenantId);
  }

  @Patch('onboarding')
  @Require('tenant.read')
  async onboarding(@Auth() auth: AuthContext, @Body(body(onboardingSchema)) input: z.infer<typeof onboardingSchema>) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      const state = { ...((t.onboardingState as object) ?? {}), ...(input.data ?? {}), ...(input.step ? { step: input.step } : {}) };
      await tx.tenant.update({ where: { id: auth.tenantId }, data: { onboardingState: state as Prisma.InputJsonValue, ...(input.completed ? { onboardingCompletedAt: new Date() } : {}) } });
    });
    return this.resource(auth.tenantId);
  }

  @Post('ownership-transfer')
  @HttpCode(200)
  @RecentAuth()
  @Require('tenant.owner')
  transfer(@Auth() auth: AuthContext, @Body(body(z.object({ targetMembershipId: uuid, reason: z.string().trim().min(1).max(300) }).strict())) input: { targetMembershipId: string; reason: string }) {
    return this.team.transferOwnership(auth, input.targetMembershipId, input.reason);
  }
}

// ═════════════════════════════ Agents ═════════════════════════════

const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: roleEnum.default('agent'), departmentIds: z.array(uuid).max(50).default([]), capacity: z.number().int().min(1).max(20).default(3) }).strict();
const agentPatchSchema = z
  .object({ displayName: z.string().trim().max(120).nullable().optional(), title: z.string().trim().max(80).nullable().optional(), role: roleEnum.optional(), enabled: z.boolean().optional(), capacity: z.number().int().min(1).max(20).optional(), expectedVersion: z.number().int().nonnegative().optional() })
  .strict();
const deptAssignSchema = z.object({ departments: z.array(z.object({ departmentId: uuid, canServe: z.boolean().default(true), canMonitor: z.boolean().default(false) }).strict()).max(100), expectedVersion: z.number().int().nonnegative().optional() }).strict();
const presenceSchema = z.object({ status: z.enum(['online', 'away', 'invisible']) }).strict();
const prefsSchema = z
  .object({
    sendOnEnter: z.boolean().optional(),
    sound: z.boolean().optional(),
    desktopNotifications: z.boolean().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    privacyMode: z.boolean().optional(),
    locale: z.enum(['en', 'ar']).nullable().optional(),
    displayName: z.string().trim().max(120).nullable().optional(),
    title: z.string().trim().max(80).nullable().optional(),
  })
  .strict();
const acceptSchema = z.object({ token: z.string().min(10).max(200), displayName: z.string().trim().max(120).optional(), password: z.string().min(12).max(128).optional() }).strict();

@Controller('agents')
export class AgentsController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @TokenAccess()
  @Require('agents.view')
  list(@Auth() auth: AuthContext) {
    return this.team.list(auth);
  }

  @Get('me')
  @AllowPendingMfa()
  me(@Auth() auth: AuthContext) {
    return this.team.me(auth);
  }

  @Patch('me/preferences')
  prefs(@Auth() auth: AuthContext, @Body(body(prefsSchema)) input: z.infer<typeof prefsSchema>) {
    return this.team.updatePreferences(auth, input);
  }

  @Put('me/presence')
  @Require('chats.serve')
  presence(@Auth() auth: AuthContext, @Body(body(presenceSchema)) input: z.infer<typeof presenceSchema>) {
    return this.team.setPresence(auth, input.status);
  }

  @Get('invitations')
  @Require('agents.manage')
  invitations(@Auth() auth: AuthContext) {
    return this.team.invitations(auth);
  }

  @Post('invitations')
  @Require('agents.manage')
  invite(@Auth() auth: AuthContext, @Body(body(inviteSchema)) input: z.infer<typeof inviteSchema>) {
    return this.team.invite(auth, input);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @Require('agents.manage')
  async revoke(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.team.revokeInvitation(auth, id);
  }

  @Public()
  @Get('invitations/lookup')
  lookup(@Query('token') token: string) {
    return this.team.lookupInvitation(token ?? '');
  }

  @Public()
  @Post('invitations/accept')
  accept(@Body(body(acceptSchema)) input: z.infer<typeof acceptSchema>, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    return this.team.acceptInvitation(input, req.user, req as Request, res);
  }

  @Patch(':id')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(agentPatchSchema)) input: z.infer<typeof agentPatchSchema>) {
    return this.team.update(auth, id, input);
  }

  @Put(':id/departments')
  @Require('agents.manage')
  departments(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(deptAssignSchema)) input: z.infer<typeof deptAssignSchema>) {
    return this.team.setDepartments(auth, id, input.departments, input.expectedVersion);
  }
}

// ═════════════════════════════ Departments ═════════════════════════════

const deptSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    publicLabel: z.string().trim().max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    enabled: z.boolean().default(true),
    scheduleId: uuid.nullable().optional(),
    routingMode: z.enum(['manual', 'broadcast', 'assigned']).default('broadcast'),
    queueLimit: z.number().int().min(1).max(10000).default(1000),
    maxWaitSeconds: z.number().int().min(0).max(3600).default(300),
    fallbackDepartmentId: uuid.nullable().optional(),
  })
  .strict();
const deptPatchSchema = deptSchema.partial().extend({ expectedVersion: z.number().int().positive().optional() }).strict();
const membersSchema = z.object({ members: z.array(z.object({ membershipId: uuid, canServe: z.boolean().default(true), canMonitor: z.boolean().default(false) }).strict()).max(500), expectedVersion: z.number().int().positive().optional() }).strict();

@Controller('departments')
export class DepartmentsController {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly broadcaster: AvailabilityBroadcaster,
  ) {}

  private async resources(tenantId: string, ids?: string[]) {
    return this.db.read(tenantId, async (tx) => {
      const rows = await tx.department.findMany({ where: { tenantId, ...(ids ? { id: { in: ids } } : {}) }, include: { members: true }, orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }] });
      const queued = await tx.chat.groupBy({ by: ['departmentId'], where: { tenantId, status: { in: ['queued', 'offered'] } }, _count: { _all: true } });
      const q = new Map(queued.map((r) => [r.departmentId, r._count._all]));
      return rows.map((d) => ({
        id: d.id,
        name: d.name,
        publicLabel: d.publicLabel,
        description: d.description,
        enabled: d.enabled,
        scheduleId: d.scheduleId,
        routingMode: d.routingMode,
        queueLimit: d.queueLimit,
        maxWaitSeconds: d.maxWaitSeconds,
        fallbackDepartmentId: d.fallbackDepartmentId,
        archivedAt: d.archivedAt,
        members: d.members.map((m) => ({ membershipId: m.membershipId, canServe: m.canServe, canMonitor: m.canMonitor })),
        queued: q.get(d.id) ?? 0,
        version: d.version,
      }));
    });
  }

  private async checkFallback(tx: Prisma.TransactionClient, tenantId: string, id: string, fallback: string | null | undefined) {
    if (!fallback) return;
    const all = await tx.department.findMany({ where: { tenantId }, select: { id: true, fallbackDepartmentId: true } });
    const edges: Record<string, string | null> = Object.fromEntries(all.map((d) => [d.id, d.fallbackDepartmentId]));
    edges[id] = fallback;
    if (!edges[fallback] && !all.some((d) => d.id === fallback)) throw notFound('Fallback department');
    if (hasFallbackCycle(edges, id)) throw conflict('CONFLICT', 'This fallback would create a loop between departments');
  }

  @Get()
  @TokenAccess()
  @Require('departments.view')
  list(@Auth() auth: AuthContext) {
    return this.resources(auth.tenantId);
  }

  @Post()
  @Require('departments.manage')
  async create(@Auth() auth: AuthContext, @Body(body(deptSchema)) input: z.infer<typeof deptSchema>) {
    const id = await this.db.tx(auth.tenantId, async (tx) => {
      const normalized = input.name.trim().toLowerCase().replace(/\s+/g, ' ');
      if (await tx.department.findFirst({ where: { tenantId: auth.tenantId, normalizedName: normalized, archivedAt: null } })) throw conflict('CONFLICT', 'A department with this name already exists');
      const d = await tx.department.create({
        data: { tenantId: auth.tenantId, name: input.name, normalizedName: normalized, publicLabel: input.publicLabel || input.name, description: input.description ?? null, enabled: input.enabled, scheduleId: input.scheduleId ?? null, routingMode: input.routingMode, queueLimit: input.queueLimit, maxWaitSeconds: input.maxWaitSeconds },
      });
      await this.checkFallback(tx, auth.tenantId, d.id, input.fallbackDepartmentId);
      if (input.fallbackDepartmentId) await tx.department.update({ where: { id: d.id }, data: { fallbackDepartmentId: input.fallbackDepartmentId } });
      await this.audit.inTx(tx, auth, { action: 'department.created', objectType: 'department', objectId: d.id, safeDiff: { name: d.name } });
      return d.id;
    });
    this.broadcaster.schedule(auth.tenantId);
    return (await this.resources(auth.tenantId, [id]))[0];
  }

  @Patch(':id')
  @Require('departments.manage')
  async update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(deptPatchSchema)) input: z.infer<typeof deptPatchSchema>) {
    await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'departments', auth.tenantId, id);
      const d = await tx.department.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!d) throw notFound('Department');
      if (input.expectedVersion && input.expectedVersion !== d.version) throw conflict('VERSION_CONFLICT', 'This department was changed by someone else. Reload to continue.');
      if (input.fallbackDepartmentId !== undefined) await this.checkFallback(tx, auth.tenantId, id, input.fallbackDepartmentId);
      const { expectedVersion: _v, ...rest } = input;
      await tx.department.update({
        where: { id },
        data: { ...rest, ...(rest.name ? { normalizedName: rest.name.trim().toLowerCase().replace(/\s+/g, ' ') } : {}), version: { increment: 1 } },
      });
      await this.audit.inTx(tx, auth, { action: 'department.updated', objectType: 'department', objectId: id, safeDiff: rest });
    });
    this.broadcaster.schedule(auth.tenantId);
    return (await this.resources(auth.tenantId, [id]))[0];
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('departments.manage')
  async archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const active = await tx.chat.count({ where: { tenantId: auth.tenantId, departmentId: id, status: { not: 'closed' } } });
      if (active) throw conflict('CONFLICT', `This department has ${active} open chat(s). Close or transfer them first.`);
      const r = await tx.department.updateMany({ where: { tenantId: auth.tenantId, id, archivedAt: null }, data: { archivedAt: new Date(), enabled: false } });
      if (!r.count) throw notFound('Department');
      await this.audit.inTx(tx, auth, { action: 'department.archived', objectType: 'department', objectId: id });
    });
    this.broadcaster.schedule(auth.tenantId);
    return (await this.resources(auth.tenantId, [id]))[0];
  }

  @Get(':id')
  @TokenAccess()
  @Require('departments.view')
  async one(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const [d] = await this.resources(auth.tenantId, [id]);
    if (!d) throw notFound('Department');
    return d;
  }

  @Put(':id/members')
  @Require('departments.manage')
  async members(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(membersSchema)) input: z.infer<typeof membersSchema>) {
    await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'departments', auth.tenantId, id);
      const d = await tx.department.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!d) throw notFound('Department');
      if (input.expectedVersion && input.expectedVersion !== d.version) throw conflict('VERSION_CONFLICT', 'This department was changed by someone else. Reload to continue.');
      const valid = await tx.membership.findMany({ where: { tenantId: auth.tenantId, id: { in: input.members.map((m) => m.membershipId) } }, select: { id: true } });
      if (valid.length !== new Set(input.members.map((m) => m.membershipId)).size) throw notFound('Agent');
      await tx.departmentMember.deleteMany({ where: { tenantId: auth.tenantId, departmentId: id } });
      if (input.members.length) await tx.departmentMember.createMany({ data: input.members.map((m) => ({ tenantId: auth.tenantId, departmentId: id, membershipId: m.membershipId, canServe: m.canServe, canMonitor: m.canMonitor })) });
      await tx.department.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, { action: 'department.members_set', objectType: 'department', objectId: id, safeDiff: { members: input.members.length } });
    });
    this.broadcaster.schedule(auth.tenantId);
    return (await this.resources(auth.tenantId, [id]))[0];
  }
}

// ═════════════════════════════ Sites ═════════════════════════════

const originSchema = z.object({ origin: z.string().trim().min(1).max(300), patternType: z.enum(['exact', 'subdomain']).default('exact') }).strict();
const siteSchema = z.object({ name: z.string().trim().min(1).max(120), origins: z.array(originSchema).max(50).default([]), defaultDepartmentId: uuid.nullable().optional() }).strict();
const sitePatchSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(), defaultDepartmentId: uuid.nullable().optional(), scheduleId: uuid.nullable().optional(), origins: z.array(originSchema).max(50).optional(), expectedVersion: z.number().int().positive().optional() })
  .strict();

@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @Require('sites.view')
  list(@Auth() auth: AuthContext) {
    return this.sites.list(auth);
  }

  @Post()
  @Require('sites.manage')
  create(@Auth() auth: AuthContext, @Body(body(siteSchema)) input: z.infer<typeof siteSchema>) {
    return this.sites.create(auth, input);
  }

  @Get(':id')
  @Require('sites.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.get(auth, id);
  }

  @Patch(':id')
  @Require('sites.manage')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(sitePatchSchema)) input: z.infer<typeof sitePatchSchema>) {
    return this.sites.update(auth, id, input);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('sites.manage')
  archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.archive(auth, id);
  }

  @Post(':id/key-rotation')
  @RecentAuth()
  @Require('sites.manage')
  rotate(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(z.object({ overlapSeconds: z.number().int().min(0).max(86400).default(3600) }).strict())) input: { overlapSeconds: number }) {
    return this.sites.rotateKey(auth, id, input.overlapSeconds);
  }

  @Get(':id/widget-config')
  @Require('sites.view')
  config(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.widgetConfig(auth, id);
  }

  @Put(':id/widget-config')
  @Require('sites.manage')
  saveDraft(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(z.object({ config: z.unknown(), baseEtag: z.string().max(128).nullable().optional() }).strict())) input: { config: unknown; baseEtag?: string | null }) {
    return this.sites.saveDraft(auth, id, input.config, input.baseEtag);
  }

  @Delete(':id/widget-config/draft')
  @Require('sites.manage')
  discardDraft(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(z.object({ etag: z.string().max(128).optional() }).strict())) q: { etag?: string }) {
    return this.sites.discardDraft(auth, id, q.etag);
  }

  @Post(':id/widget-config/publish')
  @HttpCode(200)
  @Require('sites.manage')
  publish(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(z.object({ revision: z.number().int().positive(), etag: z.string().max(128).optional() }).strict())) input: { revision: number; etag?: string }) {
    return this.sites.publish(auth, id, input.revision, input.etag);
  }

  @Get(':id/installation-status')
  @Require('sites.view')
  installation(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.installation(auth, id);
  }

  @Post(':id/identity-secret')
  @RecentAuth()
  @Require('sites.manage')
  identity(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.setIdentitySecret(auth, id, true);
  }

  @Delete(':id/identity-secret')
  @Require('sites.manage')
  removeIdentity(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.setIdentitySecret(auth, id, false);
  }
}

// ═════════════════════════════ Tags ═════════════════════════════

@Controller('tags')
export class TagsController {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @TokenAccess()
  @Require('tenant.read')
  async list(@Auth() auth: AuthContext, @Query('q') q?: string) {
    const rows = await this.db.read(auth.tenantId, (tx) =>
      tx.tag.findMany({ where: { tenantId: auth.tenantId, archivedAt: null, ...(q ? { OR: [{ slug: { contains: q.toLowerCase() } }, { label: { contains: q, mode: 'insensitive' } }] } : {}) }, orderBy: { slug: 'asc' }, take: 200 }),
    );
    return rows.map((t) => ({ id: t.id, slug: t.slug, label: t.label }));
  }

  @Post()
  @Require('tags.create')
  async create(@Auth() auth: AuthContext, @Body(body(z.object({ label: z.string().trim().min(1).max(80), slug: z.string().trim().max(64).optional() }).strict())) input: { label: string; slug?: string }) {
    const slug = (input.slug || input.label).toLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'tag';
    return this.db.tx(auth.tenantId, async (tx) => {
      if (await tx.tag.findUnique({ where: { tenantId_slug: { tenantId: auth.tenantId, slug } } })) throw conflict('CONFLICT', `A tag “${slug}” already exists`);
      const t = await tx.tag.create({ data: { tenantId: auth.tenantId, slug, label: input.label } });
      await this.audit.inTx(tx, auth, { action: 'tag.created', objectType: 'tag', objectId: t.id, safeDiff: { slug: t.slug } });
      return { id: t.id, slug: t.slug, label: t.label };
    });
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('tags.manage')
  async archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const r = await tx.tag.updateMany({ where: { tenantId: auth.tenantId, id }, data: { archivedAt: new Date() } });
      if (!r.count) throw notFound('Tag');
      await this.audit.inTx(tx, auth, { action: 'tag.archived', objectType: 'tag', objectId: id });
    });
    return { ok: true };
  }
}

