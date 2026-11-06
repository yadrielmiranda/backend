import { BadRequestException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';

const invalidMessage = 'Upload a valid PDF that opens without a password.';
const complexMessage = 'This PDF is too complex to process. Export a smaller PDF and try again.';
const activeMessage = 'Upload a PDF without scripts, attached files, or interactive actions.';

export async function validateNoteAttachmentPdf(buffer: Buffer): Promise<void> {
  if (!/%%EOF\s*$/.test(buffer.subarray(-1024).toString('latin1'))) throw new BadRequestException(invalidMessage);
  // Resolve the compiled worker in production and the TypeScript worker in development/tests.
  const filename = require.resolve('./estimate-note-attachment-pdf.worker');
  const worker = new Worker(filename, {
    workerData: buffer,
    execArgv: filename.endsWith('.ts') ? ['-r', require.resolve('ts-node/register/transpile-only')] : [],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
  });
  let timeout: NodeJS.Timeout;
  try {
    await new Promise<void>((resolve, reject) => {
      const tooComplex = () => reject(new BadRequestException(complexMessage));
      timeout = setTimeout(tooComplex, 8_000);
      worker.once('message', (result) => {
        if (result === 'ok') resolve();
        else reject(new BadRequestException(result === 'active' ? activeMessage : result === 'complex' ? complexMessage : invalidMessage));
      });
      worker.once('error', tooComplex);
      worker.once('exit', tooComplex);
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}
