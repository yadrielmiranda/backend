import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMaterialImage, MATERIAL_IMAGE_LIMIT, MATERIAL_IMAGE_PREFIX, readMaterialImage, saveMaterialImage, validateMaterialImageUrl } from './materials-images';

// A real one-pixel PNG; image-size validates its IHDR while upload validation checks the complete chunk structure.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6k1AAAAAASUVORK5CYII=', 'base64');

describe('Protected material images', () => {
  it('accepts PNG image bytes without trusting the filename or client content type', () => {
    expect(inspectMaterialImage(png)).toEqual({ extension: 'png', contentType: 'image/png', width: 1, height: 1 });
  });

  it('rejects SVG, scripts, truncated headers, corrupt structure and oversized dimensions/files', () => {
    const huge = Buffer.from(png); huge.writeUInt32BE(9000, 16);
    for (const value of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<?php echo 1;'), png.subarray(0, 24), Buffer.concat([png, Buffer.from('script')]), huge, Buffer.alloc(MATERIAL_IMAGE_LIMIT + 1)]) {
      expect(() => inspectMaterialImage(value)).toThrow();
    }
  });

  it('stores outside static uploads with immutable hash names and refuses unowned paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'impact-material-images-'));
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(directory);
    try {
      const saved = await saveMaterialImage(png);
      const key = `${createHash('sha256').update(png).digest('hex')}.png`;
      expect(saved.imageUrl).toBe(`${MATERIAL_IMAGE_PREFIX}${key}`);
      expect((await stat(join(directory, 'storage', 'material-images', key))).size).toBe(png.length);
      expect(await saveMaterialImage(png)).toEqual(saved);
      expect(await validateMaterialImageUrl(saved.imageUrl)).toBe(saved.imageUrl);
      expect(await validateMaterialImageUrl(null)).toBeNull();
      expect((await readMaterialImage(key)).buffer).toEqual(png);
      for (const url of ['https://example.test/a.png', '/uploads/a.png', `${MATERIAL_IMAGE_PREFIX}../a.png`, `${MATERIAL_IMAGE_PREFIX}${'0'.repeat(64)}.png`, `${MATERIAL_IMAGE_PREFIX}${key}?x=1`]) {
        await expect(validateMaterialImageUrl(url)).rejects.toThrow();
      }
      for (const key of ['../.env', '%2e%2e%2fa.png', '..\\image.png', 'x.svg', 'a'.repeat(64) + '.png']) {
        await expect(readMaterialImage(key)).rejects.toThrow('not found');
      }
    } finally {
      cwd.mockRestore();
      // mkdtemp returns our exact isolated test directory under the OS temp directory.
      if (directory.startsWith(join(tmpdir(), 'impact-material-images-'))) await rm(directory, { recursive: true, force: true });
    }
  });
});
