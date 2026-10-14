import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext, body } from '../../common/http';
import { AuditedRequire } from '../integrations/authz';
import { AuditEventsService } from './audit-events.service';
import { RequiresPlan } from '../billing/plan-gate';

const querySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    actorId: z.string().uuid().optional(),
    action: z
      .string()
      .max(100)
      .regex(
        /^[a-z0-9_.]+(\.\*)?$/,
        'Use an action name such as webhook.created or a prefix such as webhook.*',
      )
      .optional(),
    objectType: z
      .string()
      .max(60)
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    outcome: z.enum(['success', 'failure', 'denied']).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Audit trail (ch. 45/54): `audit.view`; safe diffs only; append-only (the app role cannot update or delete rows). */
@RequiresPlan('auditLog')
@Controller('audit-events')
export class AuditEventsController {
  constructor(private readonly events: AuditEventsService) {}

  @Get()
  @AuditedRequire('audit_log', 'audit.view')
  list(@Auth() auth: AuthContext, @Query(body(querySchema)) q: z.infer<typeof querySchema>) {
    return this.events.list(auth, q);
  }

  @Get('export.csv')
  @AuditedRequire('audit_log', 'audit.view')
  async export(
    @Auth() auth: AuthContext,
    @Query(body(querySchema)) q: z.infer<typeof querySchema>,
    @Res() res: Response,
  ) {
    const { cursor: _c, limit: _l, ...filters } = q;
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-events-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await this.events.exportCsv(auth, filters, (chunk) => res.write(chunk));
    res.end();
  }
}
