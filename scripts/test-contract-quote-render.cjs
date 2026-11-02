// Run from backend: node scripts/test-contract-quote-render.cjs
// Uses synthetic documents only. No database, application session, or external server.
const assert = require('node:assert/strict');
const path = require('node:path');
const { deflateSync } = require('node:zlib');
const puppeteer = require('puppeteer');
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
process.env.TS_NODE_PROJECT = path.join(backendRoot, 'tsconfig.json');
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { ContractPdfService } = require('../src/contracts/contract-pdf.service');
const { EstimatePdfHtmlBuilder } = require('../src/estimates/pdf/estimate-pdf-html.builder');

// Tiny distinct PNGs avoid image fixtures, network dependencies, and PDF deduplication.
function png(red, green, blue) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const logo = png(190, 20, 40), diagram = png(20, 70, 160);
const dataImage = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const snapshot = {
  number: 'CONTRACT-RENDER-SMOKE', publicPricingMode: 'detailed',
  customerPromotionsVisible: true, customerTotalPayable: '125.00',
  pieces: [{ id: 1, qty: 1, customerPrice: '125.00' }],
};

function fixtureHtml(diagrams, brokenImage) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 20mm; } body { font: 14px Arial, sans-serif; }
    img { width: 100px; height: 60px; } table { width: 100%; }
    </style></head><body><h1>Contract quote smoke test</h1>
    <img alt="Logo" src="${brokenImage ? 'data:image/png;base64,AAAA' : dataImage(logo)}">
    <p>Estimate CONTRACT-RENDER-SMOKE</p><img alt="Product diagram" src="${diagrams['1']}">
    <table><tr><td>One synthetic product</td><td>$125.00</td></tr></table>
    <script>
      // Simulate irrelevant recurring activity. The production allowlist must
      // abort every attempt; printable content and images are self-contained.
      let attempt = 0;
      const request = () => fetch('https://contract-render-smoke.invalid/background/' + attempt++).catch(() => {});
      request(); setInterval(request, 25);
    </script></body></html>`;
}

async function inspectPdf(bytes) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 1, 'Representative quote should fit on one page');
  let images = 0, textStreams = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images++;
      continue;
    }
    const decoded = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    if (/\bBT\b/.test(decoded) && /\bTj\b/.test(decoded)) textStreams++;
  }
  assert(images >= 2, `Expected separate logo and diagram image XObjects, got ${images}`);
  assert(textStreams > 0, 'Quote must contain text operators, not only images');
  return { pages: document.getPageCount(), images, textStreams };
}

async function main() {
  const originalBuilder = EstimatePdfHtmlBuilder.build;
  const originalFrontend = process.env.PDF_RENDER_FRONTEND_URL;
  process.env.PDF_RENDER_FRONTEND_URL = 'https://contract-render-smoke.invalid';
  const browser = await puppeteer.launch({
    headless: 'shell', pipe: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    async function runCase({ legacy = false, brokenImage = false } = {}) {
      const metrics = { blocked: 0, continuedExternal: 0, externalResponses: 0, pdfCalls: 0 };
      const pages = [];
      let pageIndex = 0;
      const service = new ContractPdfService();
      EstimatePdfHtmlBuilder.build = (_report, _view, diagrams) => fixtureHtml(diagrams, brokenImage);
      // Isolate only the upstream app/diagram fetch. The final page and complete
      // production quote-rendering path use a real installed Chromium browser.
      service.browser = async (work) => work({ newPage: async () => {
        if (pageIndex++ === 0) return {
          setViewport: async () => {}, goto: async () => {}, waitForSelector: async () => {}, evaluate: async () => {},
          $$: async () => [{ evaluate: async () => '1', screenshot: async () => diagram }],
        };
        const page = await browser.newPage();
        pages.push(page);
        page.on('request', (request) => {
          const external = !request.url().startsWith('data:') && request.url() !== 'about:blank';
          const abort = request.abort.bind(request), proceed = request.continue.bind(request);
          request.abort = (...args) => { if (external) metrics.blocked++; return abort(...args); };
          request.continue = (...args) => { if (external) metrics.continuedExternal++; return proceed(...args); };
        });
        page.on('response', (response) => {
          if (response.url().startsWith('https:')) metrics.externalResponses++;
        });
        const print = page.pdf.bind(page);
        page.pdf = (...args) => { metrics.pdfCalls++; return print(...args); };
        if (legacy) {
          const setContent = page.setContent.bind(page);
          page.setContent = async (html, options) => {
            try { await setContent(html, { ...options, waitUntil: 'networkidle0', timeout: 1500 }); }
            catch (error) {
              metrics.imagesReadyAtTimeout = await page.evaluate(() =>
                document.readyState === 'complete' && document.images.length === 2 &&
                Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
              throw error;
            }
          };
        }
        return page;
      } });
      try {
        return { bytes: await service.quote(snapshot, 'synthetic-token', 'synthetic-agreement'), metrics };
      } catch (error) {
        return { error, metrics };
      } finally {
        await Promise.all(pages.map(page => page.close()));
      }
    }

    const legacy = await runCase({ legacy: true });
    assert(legacy.error, 'The controlled never-idle case must reproduce the old timeout');
    assert.match(legacy.error.message, /Navigation timeout of 1500 ms exceeded/);
    assert.equal(legacy.metrics.imagesReadyAtTimeout, true, 'Document and printable images must already be loaded');
    assert(legacy.metrics.blocked > 5, 'Background activity must actually reach the production blocker');
    assert.equal(legacy.metrics.pdfCalls, 0);
    console.log('PASS former networkidle0 wait times out despite self-contained printable assets');

    const current = await runCase();
    if (current.error) throw current.error;
    assert(current.metrics.blocked > 0);
    assert.equal(current.metrics.continuedExternal, 0, 'No external request may bypass the production allowlist');
    assert.equal(current.metrics.externalResponses, 0);
    assert.equal(current.metrics.pdfCalls, 1);
    console.log('PASS current quote renders PDF with embedded images and text:', await inspectPdf(current.bytes));
    console.log('PASS external resource requests remain blocked');

    const broken = await runCase({ brokenImage: true });
    assert.equal(broken.error?.getStatus?.(), 503);
    assert.equal(broken.error.message, 'The estimate PDF images could not be loaded. Please try again.');
    assert.equal(broken.metrics.pdfCalls, 0, 'An unreadable embedded image must not produce a partial PDF');
    console.log('PASS unreadable embedded image returns a controlled error before printing');
  } finally {
    EstimatePdfHtmlBuilder.build = originalBuilder;
    if (originalFrontend === undefined) delete process.env.PDF_RENDER_FRONTEND_URL;
    else process.env.PDF_RENDER_FRONTEND_URL = originalFrontend;
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
