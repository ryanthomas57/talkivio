import { Injectable } from '@nestjs/common';
import type { CannedReply, Prisma, ScopeType } from '@prisma/client';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { randomToken, sha256 } from '../../common/crypto';
import { AppError, badRequest, conflict, denied, notFound, type AuthContext } from '../../common/http';
import { RedisService } from '../../common/redis.service';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import { assertVersion } from '../triggers/http-utils';
import { parseCsv, toCsv, unneutralizeCell } from './csv';
import { parsePlaceholders, placeholderKeys, renderPlaceholders, type PlaceholderValues } from './placeholders';

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_BODY = 8000;
const MAX_TITLE = 120;
const MAX_IMPORT_ROWS = 500;
const MAX_REPLIES_PER_TENANT = 5000;
const PREVIEW_TTL_SECONDS = 900;
const CSV_COLUMNS = ['slug', 'title', 'body', 'scope_type', 'scope_id', 'tags', 'options', 'enabled'] as const;

export interface ShortcutResource {
  id: string;
  slug: string;
  title: string;
  body: string;
  scopeType: ScopeType;
  scopeId: string | null;
  enabled: boolean;
  options: string[];
  tags: string[];
  placeholders: string[];
  usageCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  editable: boolean;
}

export interface ShortcutInput {
  slug: string;
  title: string;
  body: string;
  scopeType: ScopeType;
  scopeId?: string | null;
  options?: string[];
  tags?: string[];
  enabled?: boolean;
}

export interface ShortcutPatch {
  slug?: string;
  title?: string;
  body?: string;
  options?: string[];
  tags?: string[];
  enabled?: boolean;
}

interface ImportRow {
  line: number;
  slug: string;
  title: string;
  body: string;
  scopeType: ScopeType;
  scopeId: string | null;
  tags: string[];
  options: string[];
  enabled: boolean;
}

const codePoints = (s: string) => [...s].length;
const scopeKeyOf = (type: ScopeType, id: string | null) => (type === 'tenant' ? 'tenant' : `${type}:${id}`);

/**
 * Canned replies (ch. 18): tenant-shared, department-scoped and personal. Personal
 * replies are invisible to everyone but their owner — even by id (404).
 */
@Injectable()
export class ShortcutsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
  ) {}

  // ───────── Access rules ─────────

  canSee(auth: AuthContext, r: Pick<CannedReply, 'scopeType' | 'scopeId'>): boolean {
    if (r.scopeType === 'tenant') return true;
    if (r.scopeType === 'personal') return !!auth.membershipId && r.scopeId === auth.membershipId;
    return auth.departmentScope === 'all' || (!!r.scopeId && auth.departmentScope.includes(r.scopeId));
  }

  canManage(auth: AuthContext, scopeType: ScopeType, scopeId: string | null): boolean {
    const p = auth.permissions;
    if (scopeType === 'tenant') return p.has('shortcuts.manage_shared');
    if (scopeType === 'personal') return p.has('shortcuts.manage_personal') && !!auth.membershipId && scopeId === auth.membershipId;
    if (p.has('shortcuts.manage_shared')) return true;
    return p.has('shortcuts.manage_department') && !!scopeId && (auth.departmentScope === 'all' || auth.departmentScope.includes(scopeId));
  }

  private resource(auth: AuthContext, r: CannedReply): ShortcutResource {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      body: r.body,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      enabled: r.enabled,
      options: r.options,
      tags: r.tags,
      placeholders: placeholderKeys(r.body),
      usageCount: r.usageCount,
      archivedAt: r.archivedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      version: r.version,
      editable: this.canManage(auth, r.scopeType, r.scopeId),
    };
  }

  private visibleWhere(auth: AuthContext): Prisma.CannedReplyWhereInput {
    const or: Prisma.CannedReplyWhereInput[] = [{ scopeType: 'tenant' }];
    if (auth.departmentScope === 'all') or.push({ scopeType: 'department' });
    else if (auth.departmentScope.length) or.push({ scopeType: 'department', scopeId: { in: auth.departmentScope } });
    if (auth.membershipId) or.push({ scopeType: 'personal', scopeId: auth.membershipId });
    return { OR: or };
  }

  private async findVisible(tx: Tx, auth: AuthContext, id: string): Promise<CannedReply> {
    const r = await tx.cannedReply.findFirst({ where: { tenantId: auth.tenantId, id } });
    if (!r || !this.canSee(auth, r)) throw notFound('Reply');
    return r;
  }

  // ───────── Validation ─────────

  private fieldErrors(input: { slug?: string; title?: string; body?: string; options?: string[]; tags?: string[] }): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    const add = (k: string, m: string) => (errors[k] ??= []).push(m);
    if (input.slug !== undefined && !SLUG_RE.test(input.slug)) add('slug', 'Use 1–40 lowercase letters, digits, - or _ (starting with a letter or digit)');
    if (input.title !== undefined && (!input.title.trim() || codePoints(input.title) > MAX_TITLE)) add('title', `Title is required (max ${MAX_TITLE} characters)`);
    if (input.body !== undefined) {
      if (!input.body.trim()) add('body', 'Body is required');
      if (codePoints(input.body) > MAX_BODY) add('body', `Body must be at most ${MAX_BODY} characters`);
      for (const e of parsePlaceholders(input.body).errors) add('body', e);
    }
    if (input.options) {
      if (input.options.length > 8) add('options', 'At most 8 quick-reply options');
      input.options.forEach((o, i) => (!o.trim() || codePoints(o) > 60) && add(`options.${i}`, 'Options must be 1–60 characters'));
    }
    if (input.tags) {
      if (input.tags.length > 10) add('tags', 'At most 10 tags');
      input.tags.forEach((t, i) => !TAG_RE.test(t) && add(`tags.${i}`, 'Tags are lowercase slugs'));
    }
    return errors;
  }

  private async assertScope(tx: Tx, auth: AuthContext, scopeType: ScopeType, scopeId: string | null): Promise<void> {
    if (scopeType === 'tenant' && scopeId) throw badRequest('Tenant replies have no scope_id', { scope_id: ['Must be empty for tenant scope'] });
    if (scopeType === 'department') {
      if (!scopeId) throw badRequest('Choose a department', { scope_id: ['Required for department scope'] });
      const d = await tx.department.findFirst({ where: { tenantId: auth.tenantId, id: scopeId, archivedAt: null }, select: { id: true } });
      if (!d) throw badRequest('Department not found', { scope_id: ['Unknown department'] });
    }
    if (!this.canManage(auth, scopeType, scopeId)) throw denied('You cannot manage replies in this scope');
  }

  private async changed(tx: Tx, auth: AuthContext, r: CannedReply, action: 'created' | 'updated' | 'archived' | 'restored'): Promise<void> {
    // Configuration refresh signal (no body/title in the frame); personal replies only reach their owner.
    const scopes: OutboxScope[] = r.scopeType === 'personal' && r.scopeId ? [{ kind: 'agent', id: r.scopeId, audience: 'staff' }] : [{ kind: 'team', id: 'all', audience: 'staff' }];
    await this.outbox.append(tx, auth.tenantId, {
      aggregateType: 'canned_reply',
      aggregateId: r.id,
      aggregateVersion: r.version,
      eventType: 'shortcut.changed',
      payload: { id: r.id, action, scopeType: r.scopeType, scopeId: r.scopeType === 'personal' ? null : r.scopeId, version: r.version },
      scopes,
    });
    if (r.scopeType !== 'personal') {
      await this.audit.inTx(tx, auth, { action: `shortcut.${action}`, objectType: 'canned_reply', objectId: r.id, safeDiff: { slug: r.slug, scope_type: r.scopeType, scope_id: r.scopeId, version: r.version } });
    }
  }

  // ───────── Queries ─────────

  async list(auth: AuthContext, q: { q?: string; scope?: ScopeType | 'all'; cursor?: string; limit: number; includeArchived?: boolean; enabled?: boolean }) {
    const term = q.q?.trim().replace(/^[/#]/, '') ?? '';
    const filterHash = sha256(`shortcuts:${term}:${q.scope ?? 'all'}:${q.includeArchived ? 1 : 0}:${q.enabled ?? ''}`).slice(0, 16);
    const after = decodeCursor<{ s: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !after) throw new AppError(422, 'CURSOR_EXPIRED', 'This list changed; reload from the first page');
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.CannedReplyWhereInput[] = [{ tenantId: auth.tenantId }, this.visibleWhere(auth)];
      if (!q.includeArchived) and.push({ archivedAt: null });
      if (q.enabled !== undefined) and.push({ enabled: q.enabled });
      if (q.scope && q.scope !== 'all') and.push({ scopeType: q.scope });
      if (term) {
        and.push({
          OR: [
            { slug: { startsWith: term.toLowerCase() } },
            { title: { contains: term, mode: 'insensitive' } },
            { body: { contains: term, mode: 'insensitive' } },
          ],
        });
      }
      if (after) and.push({ OR: [{ slug: { gt: after.s } }, { slug: after.s, id: { gt: after.id } }] });
      const rows = await tx.cannedReply.findMany({ where: { AND: and }, orderBy: [{ slug: 'asc' }, { id: 'asc' }], take: q.limit + 1 });
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return page(
        items.map((r) => this.resource(auth, r)),
        more && last ? encodeCursor({ s: last.slug, id: last.id }, filterHash) : null,
      );
    });
  }

  async get(auth: AuthContext, id: string): Promise<ShortcutResource> {
    return this.db.read(auth.tenantId, async (tx) => this.resource(auth, await this.findVisible(tx, auth, id)));
  }

  // ───────── Commands ─────────

  async create(auth: AuthContext, input: ShortcutInput): Promise<ShortcutResource> {
    const scopeId = input.scopeType === 'personal' ? (input.scopeId ?? auth.membershipId ?? null) : (input.scopeId ?? null);
    const errors = this.fieldErrors(input);
    if (Object.keys(errors).length) throw badRequest('Check the highlighted fields.', errors);
    if (input.scopeType === 'personal' && (!auth.membershipId || scopeId !== auth.membershipId)) throw denied('Personal replies belong to their owner');
    return this.db.tx(auth.tenantId, async (tx) => {
      await this.assertScope(tx, auth, input.scopeType, scopeId);
      const scopeKey = scopeKeyOf(input.scopeType, scopeId);
      const existing = await tx.cannedReply.findUnique({ where: { tenantId_scopeKey_slug: { tenantId: auth.tenantId, scopeKey, slug: input.slug } } });
      if (existing && !existing.archivedAt) throw conflict('CONFLICT', `/${input.slug} already exists in this scope`, false, { field: 'slug' });
      await this.assertCapacity(tx, auth.tenantId, existing ? 0 : 1);
      const data = {
        title: input.title.trim(),
        body: input.body,
        options: (input.options ?? []).map((o) => o.trim()),
        tags: [...new Set(input.tags ?? [])],
        enabled: input.enabled ?? true,
      };
      // An archived reply with the same scope + slug is revived (UNIQUE(tenant, scope_key, slug)).
      const r = existing
        ? await tx.cannedReply.update({ where: { id: existing.id }, data: { ...data, archivedAt: null, createdBy: auth.membershipId, version: { increment: 1 } } })
        : await tx.cannedReply.create({ data: { tenantId: auth.tenantId, scopeType: input.scopeType, scopeId, scopeKey, slug: input.slug, createdBy: auth.membershipId, ...data } });
      await this.changed(tx, auth, r, existing ? 'restored' : 'created');
      return this.resource(auth, r);
    });
  }

  private async assertCapacity(tx: Tx, tenantId: string, adding: number): Promise<void> {
    if (!adding) return;
    const n = await tx.cannedReply.count({ where: { tenantId, archivedAt: null } });
    if (n + adding > MAX_REPLIES_PER_TENANT) throw new AppError(422, 'PLAN_LIMIT', `A workspace can keep at most ${MAX_REPLIES_PER_TENANT} replies`);
  }

  async update(auth: AuthContext, id: string, patch: ShortcutPatch, expectedVersion: number): Promise<ShortcutResource> {
    const errors = this.fieldErrors(patch);
    if (Object.keys(errors).length) throw badRequest('Check the highlighted fields.', errors);
    return this.db.tx(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM canned_replies WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      const r = await this.findVisible(tx, auth, id);
      if (!this.canManage(auth, r.scopeType, r.scopeId)) throw denied('You cannot edit this reply');
      if (r.archivedAt) throw conflict('CONFLICT', 'This reply is archived');
      // Never overwrite another editor silently: surface reload/merge with the current copy.
      assertVersion(expectedVersion, r.version, 'This reply', this.resource(auth, r));
      if (patch.slug && patch.slug !== r.slug) {
        const clash = await tx.cannedReply.findUnique({ where: { tenantId_scopeKey_slug: { tenantId: auth.tenantId, scopeKey: r.scopeKey, slug: patch.slug } } });
        if (clash) throw conflict('CONFLICT', `/${patch.slug} already exists in this scope`, false, { field: 'slug' });
      }
      const next = await tx.cannedReply.update({
        where: { id },
        data: {
          ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.options !== undefined ? { options: patch.options.map((o) => o.trim()) } : {}),
          ...(patch.tags !== undefined ? { tags: [...new Set(patch.tags)] } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          version: { increment: 1 },
        },
      });
      await this.changed(tx, auth, next, 'updated');
      return this.resource(auth, next);
    });
  }

  async archive(auth: AuthContext, id: string, expectedVersion: number | null): Promise<ShortcutResource> {
    return this.db.tx(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM canned_replies WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      const r = await this.findVisible(tx, auth, id);
      if (!this.canManage(auth, r.scopeType, r.scopeId)) throw denied('You cannot archive this reply');
      assertVersion(expectedVersion, r.version, 'This reply', this.resource(auth, r));
      if (r.archivedAt) return this.resource(auth, r);
      const next = await tx.cannedReply.update({ where: { id }, data: { archivedAt: new Date(), enabled: false, version: { increment: 1 } } });
      await this.changed(tx, auth, next, 'archived');
      return this.resource(auth, next);
    });
  }

  // ───────── Rendering (plain text, allowlisted placeholders) ─────────

  async render(auth: AuthContext, id: string, input: { chatId?: string; sample?: PlaceholderValues }) {
    return this.db.read(auth.tenantId, async (tx) => {
      const r = await this.findVisible(tx, auth, id);
      const out = renderPlaceholders(r.body, await this.placeholderValues(tx, auth, input));
      return { replyId: r.id, text: out.text, unresolved: out.unresolved, canSend: out.unresolved.length === 0, options: r.options };
    });
  }

  /** Preview unsaved editor text with the same placeholder engine and value sources (nothing is stored). */
  async renderPreview(auth: AuthContext, input: { body: string; options?: string[]; chatId?: string; sample?: PlaceholderValues }) {
    return this.db.read(auth.tenantId, async (tx) => {
      const out = renderPlaceholders(input.body, await this.placeholderValues(tx, auth, input));
      return { replyId: null, text: out.text, unresolved: out.unresolved, canSend: out.unresolved.length === 0, options: input.options ?? [] };
    });
  }

  /** Values for allowlisted placeholders: a chat the agent can see, or explicit sample values. */
  private async placeholderValues(tx: Tx, auth: AuthContext, input: { chatId?: string; sample?: PlaceholderValues }): Promise<PlaceholderValues> {
    let values: PlaceholderValues = {};
    if (input.chatId) {
      const chat = await tx.chat.findFirst({ where: { tenantId: auth.tenantId, id: input.chatId } });
      if (!chat) throw notFound('Chat');
      const participant = auth.membershipId
        ? await tx.chatParticipant.findFirst({ where: { tenantId: auth.tenantId, chatId: chat.id, membershipId: auth.membershipId, leftAt: null }, select: { id: true } })
        : null;
      const inScope = auth.departmentScope === 'all' || !chat.departmentId || auth.departmentScope.includes(chat.departmentId);
      if (!participant && !inScope) throw notFound('Chat');
      const [visitor, dept, site, member] = await Promise.all([
        tx.visitor.findFirst({ where: { tenantId: auth.tenantId, id: chat.visitorId }, select: { name: true } }),
        chat.departmentId ? tx.department.findFirst({ where: { tenantId: auth.tenantId, id: chat.departmentId }, select: { name: true, publicLabel: true } }) : null,
        tx.site.findFirst({ where: { tenantId: auth.tenantId, id: chat.siteId }, select: { name: true } }),
        auth.membershipId ? tx.membership.findFirst({ where: { tenantId: auth.tenantId, id: auth.membershipId }, include: { user: { select: { displayName: true } } } }) : null,
      ]);
      values = {
        // Anonymous visitors have no real name: leave it unresolved (use a fallback like {{visitor.name|there}}).
        'visitor.name': visitor?.name ?? null,
        'agent.display_name': member ? member.displayName || member.user.displayName : null,
        'department.name': dept ? dept.publicLabel || dept.name : null,
        'site.name': site?.name ?? null,
      };
    } else if (input.sample) {
      values = input.sample;
    }
    return values;
  }

  // ───────── CSV export / import ─────────

  async exportCsv(auth: AuthContext): Promise<string> {
    const rows = await this.db.read(auth.tenantId, (tx) =>
      tx.cannedReply.findMany({ where: { AND: [{ tenantId: auth.tenantId, archivedAt: null }, this.visibleWhere(auth)] }, orderBy: [{ scopeKey: 'asc' }, { slug: 'asc' }], take: MAX_REPLIES_PER_TENANT }),
    );
    return toCsv([
      [...CSV_COLUMNS],
      ...rows.map((r) => [r.slug, r.title, r.body, r.scopeType, r.scopeId ?? '', r.tags.join('|'), r.options.join('|'), r.enabled ? 'true' : 'false']),
    ]);
  }

  /** Validate CSV rows and stage them under a short-lived preview token. No writes. */
  async importPreview(auth: AuthContext, csvText: string) {
    const parsed = parseCsv(csvText, MAX_IMPORT_ROWS + 1);
    if (parsed.error) throw badRequest(`The CSV could not be read: ${parsed.error}`, { csv_text: [parsed.error] });
    if (!parsed.rows.length) throw badRequest('The CSV is empty', { csv_text: ['Add a header row and at least one reply'] });
    const header = parsed.rows[0].map((h) => h.trim().toLowerCase());
    const missing = ['slug', 'title', 'body'].filter((c) => !header.includes(c));
    const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
    if (missing.length || unknown.length) {
      throw badRequest('The header row is not valid', { csv_text: [...missing.map((m) => `Missing column "${m}"`), ...unknown.map((u) => `Unknown column "${u}"`)] });
    }
    const col = (row: string[], name: (typeof CSV_COLUMNS)[number]) => {
      const i = header.indexOf(name);
      return i < 0 ? '' : unneutralizeCell(row[i] ?? '');
    };
    return this.db.read(auth.tenantId, async (tx) => {
      const departments = new Set((await tx.department.findMany({ where: { tenantId: auth.tenantId, archivedAt: null }, select: { id: true } })).map((d) => d.id));
      const seen = new Set<string>();
      const diagnostics: Array<{ line: number; slug: string; title: string; scopeType: string; scopeId: string | null; status: 'valid' | 'rejected'; action: 'create' | 'restore' | null; errors: string[] }> = [];
      const valid: ImportRow[] = [];
      for (const [idx, row] of parsed.rows.slice(1).entries()) {
        const line = idx + 2;
        const errors: string[] = [];
        if (row.length > header.length) errors.push(`Expected ${header.length} columns, found ${row.length}`);
        const slug = col(row, 'slug').trim().replace(/^[/#]/, '').toLowerCase();
        const title = col(row, 'title').trim();
        const bodyText = col(row, 'body');
        const scopeType = (col(row, 'scope_type').trim().toLowerCase() || 'tenant') as ScopeType;
        let scopeId: string | null = col(row, 'scope_id').trim().toLowerCase() || null;
        const tags = col(row, 'tags').split('|').map((t) => t.trim().toLowerCase()).filter(Boolean);
        const options = col(row, 'options').split('|').map((o) => o.trim()).filter(Boolean);
        const enabledRaw = col(row, 'enabled').trim().toLowerCase();
        if (enabledRaw && !['true', 'false', '1', '0', 'yes', 'no'].includes(enabledRaw)) errors.push('enabled must be true or false');
        const enabled = !enabledRaw || ['true', '1', 'yes'].includes(enabledRaw);
        if (!['tenant', 'department', 'personal'].includes(scopeType)) errors.push('scope_type must be tenant, department or personal');
        if (scopeType === 'tenant' && scopeId) errors.push('Tenant replies must not have a scope_id');
        if (scopeType === 'department' && (!scopeId || !departments.has(scopeId))) errors.push('scope_id must be an existing department');
        if (scopeType === 'personal') {
          if (scopeId && scopeId !== auth.membershipId) errors.push('Personal replies can only be imported for yourself');
          scopeId = auth.membershipId;
          if (!scopeId) errors.push('Personal replies need an agent account');
        }
        if (['tenant', 'department', 'personal'].includes(scopeType) && !errors.length && !this.canManage(auth, scopeType, scopeId)) errors.push('You cannot manage replies in this scope');
        const fe = this.fieldErrors({ slug, title, body: bodyText, options, tags });
        for (const [k, msgs] of Object.entries(fe)) for (const m of msgs) errors.push(`${k}: ${m}`);
        const scopeKey = scopeKeyOf(scopeType, scopeId);
        let action: 'create' | 'restore' | null = null;
        if (!errors.length) {
          if (seen.has(`${scopeKey}/${slug}`)) errors.push(`Duplicate of an earlier row (/${slug})`);
          else {
            seen.add(`${scopeKey}/${slug}`);
            const existing = await tx.cannedReply.findUnique({ where: { tenantId_scopeKey_slug: { tenantId: auth.tenantId, scopeKey, slug } }, select: { archivedAt: true } });
            if (existing && !existing.archivedAt) errors.push(`/${slug} already exists in this scope`);
            else action = existing ? 'restore' : 'create';
          }
        }
        diagnostics.push({ line, slug, title: title.slice(0, 120), scopeType, scopeId, status: errors.length ? 'rejected' : 'valid', action: errors.length ? null : action, errors });
        if (!errors.length) valid.push({ line, slug, title, body: bodyText, scopeType, scopeId, tags: [...new Set(tags)], options, enabled });
      }
      const active = await tx.cannedReply.count({ where: { tenantId: auth.tenantId, archivedAt: null } });
      const capacityError = active + valid.length > MAX_REPLIES_PER_TENANT ? `Importing ${valid.length} replies would exceed the limit of ${MAX_REPLIES_PER_TENANT}` : null;
      const token = randomToken(24);
      const expiresAt = new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000);
      if (valid.length && !capacityError) {
        await this.redis.client.set(this.previewKey(auth.tenantId, token), JSON.stringify({ membershipId: auth.membershipId, userId: auth.userId, rows: valid }), 'EX', PREVIEW_TTL_SECONDS);
      }
      return {
        previewToken: valid.length && !capacityError ? token : null,
        expiresAt: valid.length && !capacityError ? expiresAt : null,
        summary: { total: diagnostics.length, valid: valid.length, rejected: diagnostics.length - valid.length },
        capacityError,
        rows: diagnostics,
      };
    });
  }

  private previewKey(tenantId: string, token: string): string {
    return `rd:shortcut-import:${tenantId}:${sha256(token)}`;
  }

  /** Atomic commit of a previewed import; any change since the preview rejects the whole import. */
  async importCommit(auth: AuthContext, token: string) {
    const raw = await this.redis.client.getdel(this.previewKey(auth.tenantId, token));
    if (!raw) throw conflict('TOKEN_EXPIRED', 'This import preview expired or was already used. Run the preview again.');
    const staged = JSON.parse(raw) as { membershipId: string | null; userId: string | null; rows: ImportRow[] };
    if (staged.membershipId !== auth.membershipId || staged.userId !== auth.userId) throw conflict('TOKEN_EXPIRED', 'This import preview belongs to someone else');
    return this.db.tx(auth.tenantId, async (tx) => {
      await this.assertCapacity(tx, auth.tenantId, staged.rows.length);
      const created: ShortcutResource[] = [];
      let restored = 0;
      for (const row of staged.rows) {
        if (!this.canManage(auth, row.scopeType, row.scopeId)) throw denied('Your permissions changed since the preview');
        if (row.scopeType === 'department') {
          const d = await tx.department.findFirst({ where: { tenantId: auth.tenantId, id: row.scopeId!, archivedAt: null }, select: { id: true } });
          if (!d) throw conflict('VERSION_CONFLICT', `Line ${row.line}: the department no longer exists. Run the preview again.`);
        }
        const scopeKey = scopeKeyOf(row.scopeType, row.scopeId);
        const existing = await tx.cannedReply.findUnique({ where: { tenantId_scopeKey_slug: { tenantId: auth.tenantId, scopeKey, slug: row.slug } } });
        if (existing && !existing.archivedAt) throw conflict('VERSION_CONFLICT', `Line ${row.line}: /${row.slug} was created since the preview. Run the preview again.`);
        const data = { title: row.title, body: row.body, options: row.options, tags: row.tags, enabled: row.enabled, createdBy: auth.membershipId };
        const r = existing
          ? await tx.cannedReply.update({ where: { id: existing.id }, data: { ...data, archivedAt: null, version: { increment: 1 } } })
          : await tx.cannedReply.create({ data: { tenantId: auth.tenantId, scopeType: row.scopeType, scopeId: row.scopeId, scopeKey, slug: row.slug, ...data } });
        if (existing) restored++;
        created.push(this.resource(auth, r));
      }
      await this.audit.inTx(tx, auth, { action: 'shortcut.imported', objectType: 'canned_reply', objectId: null, safeDiff: { count: created.length, restored } });
      await this.outbox.append(tx, auth.tenantId, {
        aggregateType: 'canned_reply',
        aggregateId: auth.tenantId,
        aggregateVersion: 1,
        eventType: 'shortcut.changed',
        payload: { id: null, action: 'imported', count: created.length },
        scopes: [{ kind: 'team', id: 'all', audience: 'staff' }],
      });
      return { committed: created.length, restored, items: created };
    });
  }
}
