import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { win32 } from 'node:path';
import sharp = require('sharp');
import { validateNoteAttachmentPdf } from './estimate-note-attachment-pdf';

export const NOTE_ATTACHMENT_FILE_LIMIT = 10_000_000;
const photoPixelLimit = 50_000_000;
const photoMaxSide = 3200;

function storedName(original: string, extension: string) {
  // Busboy supplies unlabelled multipart filenames as Latin-1, even when browsers sent UTF-8.
  if (/^[\x00-\xFF]*$/.test(original)) {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) original = decoded;
  }
  const stem = win32.parse(original).name.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return `${[...stem].slice(0, 120).join('') || 'attachment'}.${extension}`;
}

export async function prepareNoteAttachment(file?: Pick<Express.Multer.File, 'originalname' | 'buffer'>) {
  const buffer = file?.buffer;
  if (!buffer?.length) throw new BadRequestException('Choose a photo or PDF.');
  if (buffer.length > NOTE_ATTACHMENT_FILE_LIMIT) throw new PayloadTooLargeException('Each attachment must be 10 MB or smaller.');
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    await validateNoteAttachmentPdf(buffer);
    return { name: storedName(file.originalname, 'pdf'), mimeType: 'application/pdf', buffer };
  }

  // Only feed recognized raster formats to the decoder. In particular, SVG and multipage
  // documents are never rendered. JPEG output strips original metadata, including location.
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new BadRequestException('Choose a JPEG, PNG, WebP photo or PDF.');

  try {
    const photo = sharp(buffer, { limitInputPixels: photoPixelLimit, failOn: 'warning' });
    const metadata = await photo.metadata();
    if ((metadata.pages ?? 1) > 1) throw new Error();
    const compressed = await photo.rotate()
      .resize({ width: photoMaxSide, height: photoMaxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' })
      .jpeg({ quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true })
      .timeout({ seconds: 20 })
      .toBuffer();
    if (compressed.length > NOTE_ATTACHMENT_FILE_LIMIT)
      throw new PayloadTooLargeException('The processed photo exceeds 10 MB. Upload a smaller photo.');
    return { name: storedName(file.originalname, 'jpg'), mimeType: 'image/jpeg', buffer: compressed };
  } catch (error) {
    if (error instanceof PayloadTooLargeException) throw error;
    throw new BadRequestException('Choose a valid, still photo of 50 megapixels or less.');
  }
}
