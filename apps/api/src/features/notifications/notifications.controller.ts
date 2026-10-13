import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, body, type AuthContext } from '../../common/http';
import { NotificationsService } from './notifications.service';

const listSchema = z
  .object({
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    unreadOnly: z
      .enum(['0', '1', 'true', 'false'])
      .optional()
      .transform((v) => v === '1' || v === 'true'),
  })
  .strict();

/** The signed-in member's own in-app notifications (ch. 14). */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.notifications.list(auth, q);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@Auth() auth: AuthContext) {
    return this.notifications.markAllRead(auth);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(auth, id);
  }
}
