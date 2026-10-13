import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { zodError } from '../../common/http';
import { CommandRegistry } from '../../realtime/command-registry';
import { TeamService } from './team.service';

/** Socket parity (ch. 77): `presence.set {status}` uses the same service as PUT /agents/me/presence. */
@Injectable()
export class TeamSocketCommands implements OnModuleInit {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly team: TeamService,
  ) {}

  onModuleInit(): void {
    this.registry.registerAgent('presence.set', (ctx, cmd) => {
      const p = z.object({ status: z.enum(['online', 'away', 'invisible']) }).strict().safeParse(cmd.payload);
      if (!p.success) throw zodError(p.error);
      return this.team.setPresence(ctx.auth, p.data.status);
    });
  }
}
