// Run from backend: node scripts/test-estimate-pdf-render.cjs
// Synthetic fixtures only; every URL request is intercepted, with no app or database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deflateSync } = require('node:zlib');
const puppeteer = require('puppeteer');
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
process.env.TS_NODE_PROJECT = path.join(backendRoot, 'tsconfig.json');
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { EstimatePdfService } = require('../src/estimates/pdf/estimate-pdf.service');
const { EstimatePdfHtmlBuilder } = require('../src/estimates/pdf/estimate-pdf-html.builder');
const fontDirectory = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/public/assets');
const fontName = fs.readdirSync(fontDirectory).find(name => /^jetbrains-mono-latin-400-normal\..*\.woff2$/.test(name));
assert(fontName, 'The installed Prisma package must include its bundled font fixture');
const font = fs.readFileSync(path.join(fontDirectory, fontName));

function png(red, green, blue) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
}
const logo = png(190, 20, 40), diagram = png(20, 70, 160);
const diagramUrl = `data:image/png;base64,${diagram.toString('base64')}`;
const origin = 'https://estimate-render-smoke.invalid';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const estimate = { id: 1, number: 'PRINT-SMOKE', pieces: [{ id: 1, qty: 1 }] };

function fixtureHtml(diagrams) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 20mm; } body { font: 14px Arial, sans-serif; }
    @font-face { font-family: SmokeFont; src: url('${origin}/font.woff2') format('woff2'); }
    @media print { body { font-family: SmokeFont, Arial, sans-serif; } }
    img { width: 100px; height: 60px; }
    </style></head><body><h1>Estimate Print PDF smoke test</h1>
    <img alt="Logo" src="${origin}/logo.png"><p>One synthetic product: $125.00</p>
    <img alt="Product diagram" src="${diagrams['1']}"><script>
      let attempt = 0;
      const request = () => fetch('${origin}/background/' + attempt++).catch(() => {});
      request(); setInterval(request, 25);
    </script></body></html>`;
}

async function inspectPdf(bytes, expectedImages) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 1);
  let images = 0, fixtureImages = 0, textStreams = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images++;
      // Chromium may add its own broken-image icon when an optional logo fails.
      if (object.dict.get(PDFName.of('Width'))?.asNumber() === 1 &&
          object.dict.get(PDFName.of('Height'))?.asNumber() === 1) fixtureImages++;
      continue;
    }
    const decoded = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    if (/\bBT\b/.test(decoded) && /\bTj\b/.test(decoded)) textStreams++;
  }
  assert.equal(fixtureImages, expectedImages, 'PDF must embed each successfully loaded fixture image');
  assert(textStreams > 0, 'PDF must retain printable text');
  return { pages: document.getPageCount(), images, fixtureImages, textStreams };
}

async function main() {
  const originalLaunch = puppeteer.default.launch;
  const originalBuilder = EstimatePdfHtmlBuilder.build;
  const originalFooter = EstimatePdfHtmlBuilder.buildFooterTemplate;
  const browser = await originalLaunch({ headless: 'shell', pipe: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    EstimatePdfHtmlBuilder.build = (_estimate, _view, diagrams) => fixtureHtml(diagrams);
    EstimatePdfHtmlBuilder.buildFooterTemplate = () => '<span>Print smoke fixture</span>';
    async function runCase({ legacy = false, failedLogo = false } = {}) {
      const metrics = { blocked: 0, pdfCalls: 0, logoRequested: false, logoSettled: false, fontResponded: false };
      const pages = [];
      puppeteer.default.launch = async () => ({
        close: async () => { await Promise.all(pages.map(page => page.close())); },
        newPage: async () => {
          const page = await browser.newPage(); pages.push(page);
          await page.setRequestInterception(true);
          page.on('request', request => {
            void (async () => {
              if (request.url() === `${origin}/logo.png`) {
                metrics.logoRequested = true;
                await delay(300);
                if (failedLogo) await request.abort();
                else await request.respond({ status: 200, contentType: 'image/png', body: logo });
                metrics.logoSettled = true;
              } else if (request.url() === `${origin}/font.woff2`) {
                await delay(250);
                await request.respond({ status: 200, contentType: 'font/woff2', body: font,
                  headers: { 'Access-Control-Allow-Origin': '*' } });
                metrics.fontResponded = true;
              } else if (request.url().startsWith('data:') || request.url() === 'about:blank') {
                await request.continue();
              } else { metrics.blocked++; await request.abort(); }
            })().catch(error => { metrics.requestError = error.message; });
          });
          const print = page.pdf.bind(page);
          page.pdf = async (...args) => {
            metrics.pdfCalls++;
            metrics.readyBeforePdf = await page.evaluate(() => ({
              images: Array.from(document.images).map(image => ({ complete: image.complete, width: image.naturalWidth })),
              fontsReady: document.fonts.status === 'loaded' && document.fonts.check('14px SmokeFont'),
            }));
            return print(...args);
          };
          if (legacy) {
            const setContent = page.setContent.bind(page);
            page.setContent = async (html, options) => {
              try { await setContent(html, { ...options, waitUntil: 'networkidle0', timeout: 1500 }); }
              catch (error) {
                metrics.imagesReadyAtTimeout = await page.evaluate(() => document.readyState === 'complete' &&
                  document.images.length === 2 && Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
                throw error;
              }
            };
          }
          return page;
        },
      });
      const service = new EstimatePdfService();
      service.capturePieceDiagrams = async () => ({ 1: diagramUrl });
      try {
        return { bytes: await service.generateEstimatePdfBuffer({ estimate,
          user: { id: 1, role: { name: 'dealer' } }, view: 'dealer_public' }), metrics };
      } catch (error) { return { error, metrics }; }
    }

    const legacy = await runCase({ legacy: true });
    assert.match(legacy.error?.message ?? '', /Navigation timeout of 1500 ms exceeded/);
    assert.equal(legacy.metrics.imagesReadyAtTimeout, true);
    assert(legacy.metrics.blocked > 5); assert.equal(legacy.metrics.pdfCalls, 0);
    console.log('PASS controlled former networkidle0 timeout with document and images already loaded');

    for (const failedLogo of [false, true]) {
      const result = await runCase({ failedLogo });
      if (result.error) throw result.error;
      const { metrics } = result;
      assert.equal(metrics.requestError, undefined);
      assert(metrics.logoRequested && metrics.logoSettled && metrics.fontResponded);
      assert.equal(metrics.pdfCalls, 1);
      assert(metrics.readyBeforePdf.fontsReady, 'The print font must load before calling page.pdf');
      assert(metrics.readyBeforePdf.images.every(image => image.complete));
      assert.equal(metrics.readyBeforePdf.images[0].width > 0, !failedLogo);
      assert(metrics.readyBeforePdf.images[1].width > 0);
      console.log(failedLogo ? 'PASS unavailable optional logo still permits PDF' : 'PASS delayed URL logo and print font load before PDF',
        await inspectPdf(result.bytes, failedLogo ? 1 : 2));
    }
  } finally {
    puppeteer.default.launch = originalLaunch;
    EstimatePdfHtmlBuilder.build = originalBuilder;
    EstimatePdfHtmlBuilder.buildFooterTemplate = originalFooter;
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
