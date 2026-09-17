import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { removePlatformTermsTestPdfs } = require('../../scripts/cleanup-platform-terms-test-pdfs.cjs');

describe('Platform terms test PDF cleanup', () => {
  it('removes only generated platform terms PDFs and is safe to repeat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terms-cleanup-'));
    const uuid = '09d22a4a-cb8b-4153-a2ad-d2c3e0b37af4';
    const disposable = `platform-terms-${uuid}.pdf`;
    const retained = [`contract-${uuid}.pdf`, `${uuid}.pdf`, 'platform-terms-not-a-uuid.pdf', 'notes.txt'];
    try {
      for (const name of [disposable, ...retained]) await writeFile(join(directory, name), name);
      const nested = `platform-terms-12345678-1234-1234-1234-123456789abc.pdf`;
      await mkdir(join(directory, nested));
      await writeFile(join(directory, nested, disposable), 'Nested file');
      expect(await removePlatformTermsTestPdfs(directory)).toBe(1);
      expect((await readdir(directory)).sort()).toEqual([...retained, nested].sort());
      for (const name of retained) expect(await readFile(join(directory, name), 'utf8')).toBe(name);
      expect(await readFile(join(directory, nested, disposable), 'utf8')).toBe('Nested file');
      expect(await removePlatformTermsTestPdfs(directory)).toBe(0);
      expect(await removePlatformTermsTestPdfs(join(directory, 'missing'))).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
