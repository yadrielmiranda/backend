import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { crc32 } from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import sharp = require('sharp');
import { NOTE_ATTACHMENT_FILE_LIMIT, prepareNoteAttachment } from './estimate-note-attachment-file';

const upload = (buffer: Buffer, originalname = 'measurements.pdf') => prepareNoteAttachment({ buffer, originalname });

describe('private estimate note attachment files', () => {
  it('preserves the bytes and signature of an ordinary PDF and derives its type from the content', async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 500]);
    const bytes = Buffer.from(await document.save());
    const result = await upload(bytes, '../floor plan.png');
    expect(result).toEqual({ name: 'floor plan.pdf', mimeType: 'application/pdf', buffer: bytes });
  });

  it('rejects malformed documents, PDF JavaScript, and actions in compressed annotation objects', async () => {
    await expect(upload(Buffer.from('%PDF-1.7 not a PDF'))).rejects.toBeInstanceOf(BadRequestException);
    const document = await PDFDocument.create();
    const page = document.addPage();
    const action = document.context.obj({ S: 'Launch', F: 'program.exe' });
    page.node.set(PDFName.of('Annots'), document.context.obj([{ A: document.context.register(action) }]));
    await expect(upload(Buffer.from(await document.save()))).rejects.toThrow('interactive actions');
    const scripted = await PDFDocument.create();
    scripted.addPage();
    scripted.addJavaScript('script', 'app.alert("test")');
    await expect(upload(Buffer.from(await scripted.save()))).rejects.toThrow('scripts');
  });

  it('rejects a small file declaring an oversized decoded photo', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
    png.writeUInt32BE(9000, 16);
    png.writeUInt32BE(8000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    await expect(upload(png)).rejects.toThrow('50 megapixels');
  });

  it.each(['png', 'webp', 'jpeg'] as const)('normalizes %s images to a static JPEG and strips metadata', async format => {
    const input = await sharp({ create: { width: 3600, height: 36, channels: 3, background: 'white' } })
      .withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const result = await upload(input, '../../Muestra de instalación.abc');
    expect(result.name).toBe('Muestra de instalación.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(Math.max(metadata.width, metadata.height)).toBe(3200);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('accepts exactly 10 decimal MB, rejects larger files and ignores deceptive names', async () => {
    const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const exact = Buffer.alloc(NOTE_ATTACHMENT_FILE_LIMIT);
    photo.copy(exact);
    expect((await upload(exact, 'small.txt')).name).toEqual('small.jpg');
    await expect(upload(Buffer.alloc(NOTE_ATTACHMENT_FILE_LIMIT + 1))).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(upload(Buffer.from('<svg><script>alert(1)</script></svg>'), 'window.jpg'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(upload(Buffer.from([255, 216, 255]), 'window.jpg')).rejects.toBeInstanceOf(BadRequestException);
    await expect(prepareNoteAttachment()).rejects.toBeInstanceOf(BadRequestException);
  });
});
