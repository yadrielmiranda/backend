import { PDFDocument } from 'pdf-lib';
import { validateNoteAttachmentPdf } from './estimate-note-attachment-pdf';

describe('bounded validation of uploaded PDFs', () => {
  it('rejects a compressed object stream during expansion even with a harmless advertised object count', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const inflated = Buffer.alloc(16 * 1024 * 1024, 32);
    inflated.write('10000 0 null ');
    doc.context.register(doc.context.flateStream(inflated, { Type: 'ObjStm', N: 1, First: 8 }));
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect(bytes.length).toBeLessThan(32_000);
    await expect(validateNoteAttachmentPdf(bytes)).rejects.toThrow('too complex');
  });

  it('rejects cross-reference loops driven by a huge declared count and a tiny stream', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.register(doc.context.flateStream(Buffer.from([0]), {
      Type: 'XRef', Size: 1_000_000_000, W: [0, 1, 0],
    }));
    await expect(validateNoteAttachmentPdf(Buffer.from(await doc.save({ useObjectStreams: false })))).rejects.toThrow('too complex');
  });
});
