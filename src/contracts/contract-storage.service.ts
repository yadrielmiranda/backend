import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import { sha256 } from './agreement-content';

@Injectable()
export class ContractStorageService {
  private readonly root = resolve(
    process.env.CONTRACT_STORAGE_DIR ||
      join(process.cwd(), 'private', 'contracts'),
  );

  constructor() {
    const publicRoot = resolve(process.cwd(), 'uploads');
    if (this.root === publicRoot || this.root.startsWith(publicRoot + sep)) {
      throw new Error(
        'CONTRACT_STORAGE_DIR must be outside the public uploads directory.',
      );
    }
  }

  private path(key: string) {
    if (!/^[a-zA-Z0-9.-]{1,100}\.pdf$/.test(key) || key.includes('..'))
      throw new BadRequestException('Invalid document.');
    return join(this.root, key);
  }

  async put(key: string, buffer: Buffer) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    // El nombre nunca se reutiliza para contenido distinto.
    try {
      await fs.writeFile(this.path(key), buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        sha256(await this.read(key)) !== sha256(buffer)
      )
        throw error;
    }
  }

  async read(key: string, expectedHash?: string) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.path(key));
    } catch {
      throw new InternalServerErrorException(
        'The saved document is unavailable. Please contact the dealer.',
      );
    }
    if (expectedHash && sha256(bytes) !== expectedHash)
      throw new InternalServerErrorException(
        'The saved document could not be verified.',
      );
    return bytes;
  }

  async removeUnsignedFile(key: string | null) {
    if (key) await fs.unlink(this.path(key)).catch(() => undefined);
  }

  async validateContract(bytes: Buffer) {
    if (
      !bytes?.length ||
      bytes.length > 10 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString() !== '%PDF-'
    ) {
      throw new BadRequestException('Upload a PDF up to 10 MB.');
    }
    try {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      if (
        source.isEncrypted ||
        source.getPageCount() < 1 ||
        source.getPageCount() > 100
      )
        throw new Error();
      if (source.getForm().getFields().length)
        throw new BadRequestException(
          'Export your contract as a flattened PDF without editable fields before uploading it.',
        );
      // Copiar páginas elimina scripts y adjuntos del catálogo. Las acciones de página/anotación tampoco se conservan.
      const clean = await PDFDocument.create();
      for (const page of await clean.copyPages(
        source,
        source.getPageIndices(),
      )) {
        page.node.delete(PDFName.of('AA'));
        const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        if (annots)
          for (const ref of annots.asArray()) {
            const annotation = clean.context.lookup(ref);
            if (annotation instanceof PDFDict)
              for (const key of ['A', 'AA', 'FS'])
                annotation.delete(PDFName.of(key));
          }
        clean.addPage(page);
      }
      clean.setCreationDate(new Date(0));
      clean.setModificationDate(new Date(0));
      return Buffer.from(await clean.save());
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'Use a valid, unencrypted PDF with 1 to 100 pages.',
      );
    }
  }

  async combine(parts: Buffer[], signedAt: Date) {
    const output = await PDFDocument.create();
    for (const part of parts) {
      const source = await PDFDocument.load(part, { updateMetadata: false });
      for (const page of await output.copyPages(
        source,
        source.getPageIndices(),
      ))
        output.addPage(page);
    }
    // Descargar la misma aceptación conserva los bytes y la fecha original de firma.
    const documentDate = new Date(signedAt.getTime());
    output.setCreationDate(documentDate);
    output.setModificationDate(documentDate);
    return Buffer.from(await output.save());
  }
}
