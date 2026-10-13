import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { body, Public, Visitor, type AppRequest, type VisitorContext } from '../../common/http';
import { env, isProd, storageBrowserOrigins } from '../../config/env';
import { ChatCommandsService } from '../chats/chat-commands.service';
import { ChatQueriesService } from '../chats/chat-queries.service';
import { IdentityHandoffService } from '../visitors/identity-handoff.service';
import { ActiveVisitorGuard, visitorIpHash } from '../visitors/visitor-capability';
import { frameAncestors } from './origins';
import { WidgetService } from './widget.service';

const uuid = z.string().uuid();
const consentSchema = z.object({ analytics: z.boolean().optional(), service: z.boolean().optional(), policyVersion: z.string().max(40).optional() }).nullable().optional();
const bootstrapSchema = z.object({ siteKey: z.string().min(4).max(80), hostOrigin: z.string().max(300).nullable().optional(), locale: z.string().max(20).nullable().optional(), clientInstanceId: z.string().max(64).optional(), consent: consentSchema }).strict();
const sessionSchema = z
  .object({
    siteKey: z.string().min(4).max(80),
    hostOrigin: z.string().max(300).nullable().optional(),
    anonymousToken: z.string().max(200).nullable().optional(),
    sessionKey: z.string().max(200).nullable().optional(),
    identityToken: z.string().max(4000).nullable().optional(),
    consent: consentSchema,
    clientInstanceId: z.string().max(64).optional(),
    page: z.object({ url: z.string().max(4000).nullable().optional(), title: z.string().max(1000).nullable().optional(), referrer: z.string().max(4000).nullable().optional() }).nullable().optional(),
    locale: z.string().max(20).nullable().optional(),
    timezone: z.string().max(80).nullable().optional(),
    preview: z.boolean().optional(),
  })
  .strict();
const chatCreateSchema = z
  .object({
    clientRequestId: z.string().min(8).max(64),
    message: z.string().max(8000).nullable().optional(),
    departmentId: uuid.nullable().optional(),
    fields: z.object({ name: z.string().max(100).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional() }).strict().optional(),
    pageUrl: z.string().max(4000).nullable().optional(),
  })
  .strict();
const messageSchema = z.object({ clientMessageId: z.string().min(1).max(64), body: z.string().max(8000).nullable().optional(), attachmentIds: z.array(uuid).max(5).default([]) }).strict();
const ratingSchema = z.object({ rating: z.enum(['good', 'bad']), comment: z.string().max(2000).nullable().optional() }).strict();
const readSchema = z.object({ lastReadSeq: z.number().int().min(0) }).strict();
const identifySchema = z
  .object({
    name: z.string().max(100).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
    /** Customer-backend JWT (aud "talkivio visitor"); `external_id_token` is the SDK alias. */
    verifiedToken: z.string().max(4000).nullable().optional(),
    externalIdToken: z.string().max(4000).nullable().optional(),
  })
  .strict();
const pageInput = z.object({ url: z.string().max(4000).nullable().optional(), title: z.string().max(1000).nullable().optional(), referrer: z.string().max(4000).nullable().optional() }).nullable().optional();
const resetSchema = z
  .object({
    anonymousToken: z.string().max(200).nullable().optional(),
    consent: consentSchema,
    page: pageInput,
    locale: z.string().max(20).nullable().optional(),
    timezone: z.string().max(80).nullable().optional(),
  })
  .strict();
const visitorFieldsSchema = z.object({ customFields: z.record(z.unknown()) }).strict();
const visitorTagsSchema = z.object({ tags: z.array(z.string().max(100)).max(20) }).strict();
const handoffSchema = z
  .object({
    siteKey: z.string().min(4).max(80),
    destinationSiteId: uuid,
    destinationOrigin: z.string().min(8).max(300),
    visitorSubject: z.string().min(1).max(200),
  })
  .strict();
const redeemSchema = z
  .object({
    handoffCode: z.string().min(8).max(100),
    siteKey: z.string().min(4).max(80),
    hostOrigin: z.string().max(300).nullable().optional(),
    consent: consentSchema,
    page: pageInput,
    locale: z.string().max(20).nullable().optional(),
    timezone: z.string().max(80).nullable().optional(),
  })
  .strict();
const consentUpdateSchema = z.object({ purpose: z.enum(['analytics', 'service']), state: z.enum(['granted', 'denied', 'withdrawn']), policyVersion: z.string().min(1).max(40) }).strict();
const eventsSchema = z
  .object({
    events: z
      .array(z.object({ id: z.string().min(1).max(64), kind: z.enum(['entered', 'left', 'visible', 'hidden']), url: z.string().max(4000).nullable().optional(), title: z.string().max(1000).nullable().optional(), clientAt: z.string().max(40).nullable().optional() }).strict())
      .max(20),
  })
  .strict();
const pageSchema = z.object({ afterSeq: z.coerce.number().int().min(0).optional(), beforeSeq: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

/** Public widget API (ch. 46). Mounted at /widget/v1 (outside the agent API prefix). */
@Controller('widget/v1')
export class WidgetController {
  constructor(
    private readonly widget: WidgetService,
    private readonly commands: ChatCommandsService,
    private readonly queries: ChatQueriesService,
    private readonly handoffs: IdentityHandoffService,
  ) {}

  @Public()
  @Post('bootstrap')
  @HttpCode(200)
  bootstrap(@Body(body(bootstrapSchema)) input: z.infer<typeof bootstrapSchema>, @Req() req: Request) {
    return this.widget.bootstrap({ siteKey: input.siteKey, hostOrigin: input.hostOrigin ?? null, locale: input.locale }, { ip: req.ip ?? null });
  }

  @Public()
  @Post('sessions')
  sessions(@Body(body(sessionSchema)) input: z.infer<typeof sessionSchema>, @Req() req: AppRequest) {
    return this.widget.createSession({ ...input, hostOrigin: input.hostOrigin ?? null, isPreview: input.preview }, { ip: req.ip ?? null, headers: req.headers, requestId: req.requestId });
  }

  /**
   * Customer backend → single-use 60 s handoff code (ch. 26). Authenticated by a
   * JWT signed with the source site's identity secret (aud "talkivio handoff").
   */
  @Public()
  @Post('identity/handoff')
  handoff(@Headers('authorization') authorization: string | undefined, @Body(body(handoffSchema)) input: z.infer<typeof handoffSchema>, @Req() req: AppRequest) {
    return this.handoffs.issue(authorization, input, { ipHash: visitorIpHash(req.ip), requestId: req.requestId ?? '' });
  }

  /** Destination widget redeems the code once → destination-scoped capability for the same visitor. */
  @Public()
  @Post('identity/redeem')
  @HttpCode(200)
  redeem(@Body(body(redeemSchema)) input: z.infer<typeof redeemSchema>, @Req() req: AppRequest) {
    return this.widget.redeemHandoff({ ...input, hostOrigin: input.hostOrigin ?? null }, { ip: req.ip ?? null, headers: req.headers, requestId: req.requestId });
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('socket-ticket')
  ticket(@Visitor() v: VisitorContext) {
    return this.widget.socketTicket(v);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Get('availability')
  availability(@Visitor() v: VisitorContext) {
    return this.widget.availabilityFor(v);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('identity')
  @HttpCode(200)
  identify(@Visitor() v: VisitorContext, @Body(body(identifySchema)) input: z.infer<typeof identifySchema>) {
    return this.widget.identify(v, { name: input.name, email: input.email, verifiedToken: input.verifiedToken ?? input.externalIdToken ?? null });
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('identity/reset')
  @HttpCode(200)
  reset(@Visitor() v: VisitorContext, @Body(body(resetSchema)) input: z.infer<typeof resetSchema>, @Req() req: AppRequest) {
    return this.widget.resetIdentity(v, input, { ip: req.ip ?? null, headers: req.headers, requestId: req.requestId });
  }

  /** SDK setCustomFields: public_writable definitions only. */
  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Put('visitor/custom-fields')
  customFields(@Visitor() v: VisitorContext, @Body(body(visitorFieldsSchema)) input: z.infer<typeof visitorFieldsSchema>) {
    return this.widget.setVisitorCustomFields(v, input.customFields);
  }

  /** SDK setTags: existing tags only, stored with source `client`; agent tags are never removed. */
  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Put('visitor/tags')
  tags(@Visitor() v: VisitorContext, @Body(body(visitorTagsSchema)) input: z.infer<typeof visitorTagsSchema>) {
    return this.widget.setVisitorTags(v, input.tags);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Put('consent')
  consent(@Visitor() v: VisitorContext, @Body(body(consentUpdateSchema)) input: z.infer<typeof consentUpdateSchema>) {
    return this.widget.setConsent(v, input);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('events')
  @HttpCode(202)
  events(@Visitor() v: VisitorContext, @Body(body(eventsSchema)) input: z.infer<typeof eventsSchema>) {
    return this.widget.ingestEvents(v, input.events);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('chats')
  async createChat(@Visitor() v: VisitorContext, @Body(body(chatCreateSchema)) input: z.infer<typeof chatCreateSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.commands.admit(v, input);
    res.status(r.status);
    return r.body;
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Get('chats/:id')
  async chat(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.widget.assertChatOnSite(v, id);
    return this.queries.visitorChat(v, id);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Get('chats/:id/messages')
  async messages(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(pageSchema)) q: z.infer<typeof pageSchema>) {
    await this.widget.assertChatOnSite(v, id);
    const r = await this.queries.visitorMessages(v, id, q);
    return { items: r.items, throughSeq: r.throughSeq, lastSeq: r.lastSeq, hasMore: r.hasMore };
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('chats/:id/messages')
  async send(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(messageSchema)) input: z.infer<typeof messageSchema>) {
    return this.commands.visitorSend(v, id, input);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Put('chats/:id/read-cursor')
  read(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(readSchema)) input: z.infer<typeof readSchema>) {
    return this.commands.readCursor({ visitor: v }, id, input.lastReadSeq);
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Post('chats/:id/close')
  @HttpCode(200)
  async close(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.commands.close({ kind: 'visitor', visitor: v }, id, { reason: 'visitor_ended' })).chat;
  }

  @Public()
  @UseGuards(ActiveVisitorGuard)
  @Put('chats/:id/rating')
  rate(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(ratingSchema)) input: z.infer<typeof ratingSchema>) {
    return this.commands.rate(v, id, input);
  }
}

export function widgetDistDir(): string {
  return process.env.WIDGET_DIST_DIR ? resolve(process.env.WIDGET_DIST_DIR) : resolve(__dirname, '../../../../widget/dist');
}

function assetVersion(file: string): string {
  try {
    return statSync(file).mtimeMs.toString(36);
  } catch {
    return 'dev';
  }
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The isolated widget iframe document with frame-ancestors generated from approved site origins. */
@Controller('widget')
export class WidgetFrameController {
  constructor(private readonly widget: WidgetService) {}

  @Public()
  @Get('frame/:siteKey')
  async frame(@Param('siteKey') siteKey: string, @Query('preview') preview: string | undefined, @Res() res: Response) {
    let ancestors: string;
    try {
      const site = await this.widget.resolveSite(siteKey);
      const rules = await this.widget.origins(site.tenantId, site.siteId);
      // Dashboard live preview: only the dashboard (plus localhost in development) may embed it.
      ancestors = preview === '1' ? [new URL(env().APP_URL).origin, ...(isProd() ? [] : ['http://localhost:*', 'http://127.0.0.1:*'])].join(' ') : frameAncestors(rules);
    } catch {
      res.status(404).type('text/plain').send('Unknown widget');
      return;
    }
    const dist = widgetDistDir();
    const js = resolve(dist, 'frame/frame.js');
    const css = resolve(dist, 'frame/frame.css');
    if (!existsSync(js)) {
      res.status(503).type('text/plain').send('Widget assets are not built. Run `pnpm --filter @talkivio/widget build`.');
      return;
    }
    const api = new URL(env().API_URL);
    const ws = `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`;
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: https:${isProd() ? '' : ' http:'}`,
        "font-src 'self' data:",
        `connect-src 'self' ${ws} ${api.origin}${storageBrowserOrigins().map((o) => ` ${o}`).join('')}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${ancestors}`,
      ].join('; '),
    );
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>Chat</title>
${existsSync(css) ? `<link rel="stylesheet" href="/widget/frame/frame.css?v=${assetVersion(css)}">` : ''}
</head><body data-site-key="${escAttr(siteKey)}" data-widget-id="${escAttr(siteKey)}" data-api="${escAttr(api.origin)}" data-preview="${preview === '1' ? '1' : '0'}" data-version="${assetVersion(js)}"><div id="app"></div>
<script type="module" src="/widget/frame/frame.js?v=${assetVersion(js)}"></script></body></html>`);
  }
}
