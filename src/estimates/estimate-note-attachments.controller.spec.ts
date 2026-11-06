import { ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Subject } from 'rxjs';
import * as request from 'supertest';
import sharp = require('sharp');
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { NOTE_ATTACHMENT_FILE_LIMIT } from './estimate-note-attachment-file';
import { EstimateNoteAttachmentsController, EstimateNoteUploadCapacityInterceptor, EstimateNoteUploadGuard } from './estimate-note-attachments.controller';
import { EstimateNoteAttachmentsService } from './estimate-note-attachments.service';

describe('internal estimate attachment HTTP', () => {
  let app: INestApplication;
  const actor = { id: 14, role: { name: 'dealer' } };
  const endpoint = '/estimates/81/internal-note/attachments';
  const attachments = { assertCanUpload: jest.fn(), add: jest.fn(), read: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EstimateNoteAttachmentsController],
      providers: [EstimateNoteUploadGuard, EstimateNoteUploadCapacityInterceptor, { provide: EstimateNoteAttachmentsService, useValue: attachments }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(ctx: ExecutionContext) {
      ctx.switchToHttp().getRequest().user = actor;
      return true;
    } }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('checks the estimate write permission before trying to decode any file', async () => {
    attachments.assertCanUpload.mockRejectedValueOnce(new ForbiddenException());
    await request(app.getHttpServer()).post(endpoint).attach('file', Buffer.from('bad'), 'bad.png').expect(403);
    expect(attachments.assertCanUpload).toHaveBeenCalledWith(81, actor);
    expect(attachments.add).not.toHaveBeenCalled();
  });

  it('limits concurrent incoming uploads and keeps a slot while a fully received photo is being processed', () => {
    const capacity = new EstimateNoteUploadCapacityInterceptor();
    const start = (complete: boolean) => {
      const req = Object.assign(new EventEmitter(), { complete });
      const work = new Subject();
      const http = { getRequest: () => req, getResponse: () => ({ set: jest.fn() }) };
      capacity.intercept({ switchToHttp: () => http } as unknown as ExecutionContext, { handle: () => work })
        .subscribe({ error: () => undefined });
      return { req, work };
    };
    const processing = start(true);
    const receiving = start(false);
    expect(() => start(true)).toThrow('Other attachments');
    processing.req.emit('close');
    expect(() => start(true)).toThrow('Other attachments');
    receiving.req.emit('close');
    const replacement = start(true);
    receiving.work.error(new Error('client disconnected'));
    expect(() => start(true)).toThrow('Other attachments');
    replacement.work.error(new Error('invalid image'));
    processing.work.complete();
    expect(() => { start(true); start(true); }).not.toThrow();
  });

  it('accepts a 10 MB upload, stores the normalized photo only, and rejects the first byte over the limit', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const padded = Buffer.alloc(NOTE_ATTACHMENT_FILE_LIMIT + 1);
    jpeg.copy(padded);
    attachments.add.mockResolvedValueOnce({ attachments: [], usedBytes: 0, storage: null });
    await request(app.getHttpServer()).post(endpoint)
      .attach('file', padded.subarray(0, NOTE_ATTACHMENT_FILE_LIMIT), 'test.original').expect(201);
    expect(attachments.add).toHaveBeenCalledWith(81, expect.objectContaining({ name: 'test.jpg', mimeType: 'image/jpeg' }), actor);
    expect(attachments.add.mock.calls[0][1].buffer.length).toBeLessThan(1024);
    await request(app.getHttpServer()).post(endpoint).attach('file', padded, 'test.jpg').expect(413);
    expect(attachments.add).toHaveBeenCalledTimes(1);
  });

  it.each([['', 'inline'], ['?download=1', 'attachment']])('serves private, correctly named files for %s', async (query, disposition) => {
    const id = randomUUID();
    const bytes = Buffer.from([255, 216, 255, 217]);
    attachments.read.mockResolvedValueOnce({ name: 'Medición 1.jpg', mimeType: 'image/jpeg', buffer: bytes });
    const response = await request(app.getHttpServer()).get(endpoint + '/' + id + query)
      .expect(200).expect('Content-Type', 'image/jpeg').expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect('Content-Disposition', disposition + "; filename*=UTF-8''Medici%C3%B3n%201.jpg");
    expect(response.body).toEqual(bytes);
    expect(attachments.read).toHaveBeenCalledWith(81, id, actor);
  });
});
