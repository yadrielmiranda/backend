import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';

export const MATERIAL_IMAGE_LIMIT = 5 * 1024 * 1024;
export const MATERIAL_IMAGE_PREFIX = '/api/materials/images/';
const storageDirectory = () => join(process.cwd(), 'storage', 'material-images');
const safeKey = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/** Detect the bytes themselves. Filenames and client-provided MIME types are not trusted. */
export function inspectMaterialImage(buffer: Buffer) {
  if (!buffer?.length || buffer.length > MATERIAL_IMAGE_LIMIT) throw new BadRequestException('Choose an image smaller than 5 MB.');
  let extension: keyof typeof mimeTypes;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    extension = 'png';
    let offset = 8, sawData = false, ended = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset), end = offset + 12 + size;
      if (end > buffer.length) break;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (offset === 8 && (type !== 'IHDR' || size !== 13)) break;
      if (type === 'IDAT') sawData = true;
      if (type === 'IEND') { ended = size === 0 && end === buffer.length; break; }
      offset = end;
    }
    if (!sawData || !ended) throw new BadRequestException('The PNG image is incomplete or invalid.');
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    extension = 'jpg';
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) {
    extension = 'webp';
  } else {
    throw new BadRequestException('Choose a valid JPEG, PNG or WebP image.');
  }
  try {
    const dimensions = imageSize(buffer);
    if (!['jpg', 'png', 'webp'].includes(dimensions.type) || !dimensions.width || !dimensions.height ||
      dimensions.width > 8000 || dimensions.height > 8000 || dimensions.width * dimensions.height > 24000000)
      throw new Error('Unsupported dimensions');
    return { extension, contentType: mimeTypes[extension], width: dimensions.width, height: dimensions.height };
  } catch {
    throw new BadRequestException('Choose a valid image up to 8000 pixels per side and 24 megapixels.');
  }
}

export async function saveMaterialImage(buffer: Buffer) {
  const { extension } = inspectMaterialImage(buffer);
  const key = `${createHash('sha256').update(buffer).digest('hex')}.${extension}`;
  const directory = storageDirectory();
  await mkdir(directory, { recursive: true });
  // The same upload has the same immutable URL, including retries after a lost response.
  await writeFile(join(directory, key), buffer);
  return { imageUrl: `${MATERIAL_IMAGE_PREFIX}${key}` };
}

export async function validateMaterialImageUrl(value?: string | null) {
  if (!value) return null;
  if (!value.startsWith(MATERIAL_IMAGE_PREFIX)) throw new BadRequestException('Upload a product image before assigning it.');
  const key = value.slice(MATERIAL_IMAGE_PREFIX.length);
  if (!safeKey.test(key)) throw new BadRequestException('Invalid product image.');
  try {
    const file = await stat(join(storageDirectory(), key));
    if (!file.isFile() || file.size <= 0 || file.size > MATERIAL_IMAGE_LIMIT) throw new Error('Invalid file');
  } catch {
    throw new BadRequestException('The uploaded image was not found. Upload it again.');
  }
  return value;
}

export async function readMaterialImage(key: string) {
  if (!safeKey.test(key)) throw new NotFoundException('Product image not found.');
  try {
    const buffer = await readFile(join(storageDirectory(), key));
    return { buffer, contentType: mimeTypes[key.split('.').pop() as keyof typeof mimeTypes] };
  } catch {
    throw new NotFoundException('Product image not found.');
  }
}
