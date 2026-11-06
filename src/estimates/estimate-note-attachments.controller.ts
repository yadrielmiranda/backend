import {
  BadRequestException, CallHandler, CanActivate, Controller, Delete, ExecutionContext, Get, Header, HttpException, Injectable,
  NestInterceptor, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { defer, finalize } from 'rxjs';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { NOTE_ATTACHMENT_FILE_LIMIT, prepareNoteAttachment } from './estimate-note-attachment-file';
import { EstimateNoteAttachmentsService } from './estimate-note-attachments.service';

@Injectable()
export class EstimateNoteUploadGuard implements CanActivate {
  constructor(private readonly attachments: EstimateNoteAttachmentsService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647)
      throw new BadRequestException('Invalid estimate ID.');
    // Reject unauthorized uploads before Multer buffers them or the image decoder runs.
    await this.attachments.assertCanUpload(id, req.user as AuthUser);
    return true;
  }
}

@Injectable()
export class EstimateNoteUploadCapacityInterceptor implements NestInterceptor {
  private active = 0;

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    if (this.active >= 2) {
      http.getResponse<Response>().set('Retry-After', '3');
      throw new HttpException('Other attachments are uploading. Try again in a moment.', 429);
    }
    ++this.active;
    // Keep a slot from the first multipart byte through normalization and the final disk write.
    const req = http.getRequest<Request>();
    let released = false;
    const release = () => {
      if (!released) --this.active;
      released = true;
      req.removeListener('close', interrupted);
    };
    const interrupted = () => { if (!req.complete) release(); };
    req.once('close', interrupted);
    return defer(() => next.handle()).pipe(finalize(release));
  }
}

@UseGuards(JwtAuthGuard)
@Controller('estimates/:id/internal-note/attachments')
export class EstimateNoteAttachmentsController {
  constructor(private readonly attachments: EstimateNoteAttachmentsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.attachments.list(id, req.user as AuthUser);
  }

  @Post()
  @UseGuards(EstimateNoteUploadGuard)
  @UseInterceptors(EstimateNoteUploadCapacityInterceptor, FileInterceptor('file', {
    storage: memoryStorage(),
    // Busboy emits its limit event on equality. Keep the documented 10 MB boundary inclusive.
    limits: { fileSize: NOTE_ATTACHMENT_FILE_LIMIT + 1, files: 1, fields: 0, parts: 2 },
  }))
  async add(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.attachments.add(id, await prepareNoteAttachment(file), req.user as AuthUser);
  }

  @Get(':attachmentId')
  async read(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('download') download: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const file = await this.attachments.read(id, attachmentId, req.user as AuthUser);
    const disposition = download === '1' ? 'attachment' : 'inline';
    const filename = encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(file.buffer);
  }

  @Delete(':attachmentId')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: Request,
  ) {
    return this.attachments.remove(id, attachmentId, req.user as AuthUser);
  }
}
