import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Auth, body, Public, Require, Visitor, type AuthContext, type VisitorContext } from '../../common/http';
import { VisitorGuard } from '../widget/capability';
import { FilesService } from './files.service';

const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/, 'Must be a hex SHA-256 digest');
const uploadSchema = z
  .object({
    chatId: z.string().uuid(),
    name: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    mime: z.string().max(255).default(''),
    sha256: sha256.nullable().optional(),
  })
  .strict();
const widgetUploadSchema = uploadSchema;
const finalizeSchema = z.object({ sha256 }).strict();

/** Agent attachment API (ch. 44). */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads')
  @Require('chats.serve')
  initUpload(@Auth() auth: AuthContext, @Body(body(uploadSchema)) input: z.infer<typeof uploadSchema>) {
    return this.files.initUpload({ kind: 'agent', auth }, input);
  }

  @Post(':id/finalize')
  @HttpCode(202)
  @Require('chats.serve')
  finalize(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(finalizeSchema)) input: z.infer<typeof finalizeSchema>) {
    return this.files.finalize({ kind: 'agent', auth }, id, input.sha256);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.getForAgent(auth, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.files.cancel({ kind: 'agent', auth }, id);
  }

  @Get(':id/download')
  download(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.downloadGrant({ kind: 'agent', auth }, id);
  }

  /** Local storage driver: signed, expiring, single-use upload target (the signature is the credential). */
  @Public()
  @Put(':id/content')
  upload(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Req() req: Request) {
    return this.files.receiveLocal('agent', id, sig, req);
  }

  /** Local driver / proxy mode: 60-second signed download. */
  @Public()
  @Get(':id/content')
  async content(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Res() res: Response): Promise<void> {
    await this.files.serveContent('agent', id, sig, res);
  }
}

/** Public widget attachment API (ch. 46 + ch. 77 REST fallbacks). */
@Controller('widget/v1')
export class WidgetFilesController {
  constructor(private readonly files: FilesService) {}

  @Public()
  @UseGuards(VisitorGuard)
  @Post('uploads')
  initUpload(@Visitor() v: VisitorContext, @Body(body(widgetUploadSchema)) input: z.infer<typeof widgetUploadSchema>) {
    return this.files.initUpload({ kind: 'visitor', visitor: v }, input);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Post('uploads/:id/finalize')
  @HttpCode(202)
  finalize(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(finalizeSchema)) input: z.infer<typeof finalizeSchema>) {
    return this.files.finalize({ kind: 'visitor', visitor: v }, id, input.sha256);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Get('uploads/:id')
  state(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.getForUploader({ kind: 'visitor', visitor: v }, id);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Delete('uploads/:id')
  @HttpCode(204)
  async cancel(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.files.cancel({ kind: 'visitor', visitor: v }, id);
  }

  @Public()
  @Put('uploads/:id/content')
  upload(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Req() req: Request) {
    return this.files.receiveLocal('widget', id, sig, req);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Get('attachments/:id/download')
  download(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.downloadGrant({ kind: 'visitor', visitor: v }, id);
  }

  @Public()
  @Get('attachments/:id/content')
  async content(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Res() res: Response): Promise<void> {
    await this.files.serveContent('widget', id, sig, res);
  }
}
