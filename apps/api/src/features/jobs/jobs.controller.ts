import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Auth, Require, type AuthContext } from '../../common/http';
import { JobsService } from './jobs.service';

/** `GET /jobs/{id}` (ch. 45). */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get(':id')
  @Require('tenant.read')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(auth, id);
  }
}
