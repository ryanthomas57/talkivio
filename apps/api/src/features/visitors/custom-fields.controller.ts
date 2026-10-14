import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Auth, body, Require, type AuthContext } from '../../common/http';
import { CUSTOM_FIELD_TYPES, CustomFieldsService } from './custom-fields.service';
import { requireVersion } from './visitor-common';

const createSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(80),
    dataType: z.enum(CUSTOM_FIELD_TYPES),
    validation: z.record(z.unknown()).optional(),
    publicWritable: z.boolean().optional(),
    visibleToVisitor: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    dataType: z.enum(CUSTOM_FIELD_TYPES).optional(),
    validation: z.record(z.unknown()).optional(),
    publicWritable: z.boolean().optional(),
    visibleToVisitor: z.boolean().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const listSchema = z.object({ includeArchived: z.enum(['true', 'false']).optional() }).strict();

/** Custom field definitions (ch. 37/43). */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @Require('tenant.read')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.fields.list(auth, q.includeArchived === 'true');
  }

  @Post()
  @Require('custom_fields.manage')
  create(@Auth() auth: AuthContext, @Body(body(createSchema)) input: z.infer<typeof createSchema>) {
    return this.fields.create(auth, input);
  }

  @Patch(':id')
  @Require('custom_fields.manage')
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(body(patchSchema)) input: z.infer<typeof patchSchema>,
  ) {
    const { expectedVersion, ...patch } = input;
    return this.fields.update(auth, id, requireVersion(ifMatch, expectedVersion), patch);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('custom_fields.manage')
  archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.archive(auth, id);
  }
}
