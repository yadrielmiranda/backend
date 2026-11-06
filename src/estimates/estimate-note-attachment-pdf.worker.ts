import { parentPort, workerData } from 'node:worker_threads';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObject, PDFStream, PDFString,
} from 'pdf-lib';
import ByteStream from 'pdf-lib/cjs/core/parser/ByteStream';
import DecodeStream from 'pdf-lib/cjs/core/streams/DecodeStream';

const blockedKeys = new Set(['AA', 'JavaScript', 'JS', 'EmbeddedFiles', 'EF', 'RichMediaContent', 'XFA']);
const blockedNames = new Set(['JavaScript', 'Launch', 'EmbeddedFile', 'FileAttachment', 'RichMedia', 'Movie',
  'Sound', 'Rendition', '3D', 'GoToE', 'GoToR', 'SubmitForm', 'ImportData']);
const maxStreamBytes = 8 * 1024 * 1024;
const maxAllocations = 48 * 1024 * 1024;
const maxEntries = 100_000;
let budgetExceeded = false;

function rejectComplex(): never {
  // The parser wraps some stream errors. Preserve the reason for the upload response.
  budgetExceeded = true;
  throw new Error('PDF processing limit');
}

function installParseLimits() {
  let remaining = maxAllocations;
  function consume(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) rejectComplex();
    remaining -= bytes;
  }

  // Worker V8 heap limits do not cover typed arrays. In pinned pdf-lib 1.17.1 all filters
  // (including Flate, LZW and chained filters) grow their output via this allocator.
  // Check each allocation before it happens, including intermediate buffers and growth copies.
  type DecoderBuffer = { buffer: Uint8Array; minBufferLength: number };
  const decoder = DecodeStream.prototype as unknown as {
    ensureBuffer(this: DecoderBuffer, requested: number): Uint8Array;
  };
  const grow = decoder.ensureBuffer;
  decoder.ensureBuffer = function (requested) {
    if (requested > this.buffer.byteLength) {
      if (requested > maxStreamBytes) rejectComplex();
      let capacity = this.minBufferLength;
      while (capacity < requested) capacity *= 2;
      if (capacity > maxStreamBytes) rejectComplex();
      consume(capacity);
    }
    return grow.call(this, requested);
  };

  // This parser runs only inside this upload worker. Nothing modifies the parser used
  // to generate contracts and other documents in the portal.
  const copy = ByteStream.prototype.slice;
  ByteStream.prototype.slice = function (start, end) {
    consume(end - start);
    return copy.call(this, start, end);
  };
  const decode = ByteStream.fromPDFRawStream;
  ByteStream.fromPDFRawStream = (stream) => {
    const dict = stream.dict;
    const filters = dict.lookup(PDFName.of('Filter'));
    if (filters instanceof PDFArray && filters.size() > 4) rejectComplex();
    if (dict.lookup(PDFName.of('Type')) === PDFName.of('ObjStm')) {
      const count = dict.lookup(PDFName.of('N'), PDFNumber).asNumber();
      if (!Number.isSafeInteger(count) || count < 0 || count > maxEntries) rejectComplex();
    } else {
      const index = dict.lookup(PDFName.of('Index'));
      let count = 0;
      if (index instanceof PDFArray) {
        if (index.size() % 2 || index.size() > 2 * maxEntries) rejectComplex();
        for (let i = 1; i < index.size(); i += 2) {
          const section = index.lookup(i, PDFNumber).asNumber();
          if (!Number.isSafeInteger(section) || section < 0) rejectComplex();
          count += section;
        }
      } else {
        count = dict.lookup(PDFName.of('Size'), PDFNumber).asNumber();
      }
      const widths = dict.lookup(PDFName.of('W'), PDFArray);
      if (!Number.isSafeInteger(count) || count < 0 || count > maxEntries || widths.size() !== 3) rejectComplex();
      for (let i = 0; i < 3; i++) {
        const width = widths.lookup(i, PDFNumber).asNumber();
        if (!Number.isSafeInteger(width) || width < 0 || width > 8) rejectComplex();
      }
    }
    return decode(stream);
  };
}

async function validate() {
  try {
    installParseLimits();
    const doc = await PDFDocument.load(workerData, { updateMetadata: false, throwOnInvalidObject: true });
    if (!doc.getPageCount()) return 'invalid';
    const pending: PDFObject[] = doc.context.enumerateIndirectObjects().map(([, object]) => object);
    while (pending.length) {
      const object = pending.pop();
      if (object instanceof PDFArray) for (const entry of object.asArray()) pending.push(entry);
      if (object instanceof PDFName && blockedNames.has(object.decodeText())) return 'active';
      const dict = object instanceof PDFStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      for (const [key, value] of dict.entries()) {
        if (blockedKeys.has(key.decodeText())) return 'active';
        pending.push(value);
      }
      if (dict.has(PDFName.of('URI'))) {
        const uri = dict.lookup(PDFName.of('URI'));
        if ((uri instanceof PDFString || uri instanceof PDFHexString) && !/^(https?:\/\/|mailto:)/i.test(uri.decodeText())) return 'active';
      }
    }
    return 'ok';
  } catch {
    return budgetExceeded ? 'complex' : 'invalid';
  }
}

void validate().then(result => parentPort.postMessage(result));
