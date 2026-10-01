// Offline browser regression tests. Uses the already installed Puppeteer browser.
// Run from backend: node --test test/estimate-pdf-diagrams.test.cjs
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const puppeteer = require('puppeteer');

require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { EstimatePdfService } = require('../src/estimates/pdf/estimate-pdf.service');

const reportUrl = 'https://pdf-fixture.invalid/estimates/9?pdfDiagramCapture=1';
const diagramHtml = `<!doctype html><html><body style="margin:0;background:white">
  <style>
    section { margin:32px; padding:8px; width:240px; height:200px; background:#f1f5f9; }
    [data-piece-diagram-id] { width:100%; height:100%; }
    svg { display:block; width:100%; height:100%; }
  </style>
  ${[77, 78, 79].map((id) => `<section>
    <div data-piece-diagram-id="${id}">
      <svg viewBox="0 0 240 200" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="glass-${id}"><stop stop-color="#ddd"/><stop offset="1" stop-color="#aaa"/></linearGradient></defs>
        <rect x="40" y="10" width="160" height="180" fill="#443f3b"/>
        <rect x="50" y="20" width="140" height="75" fill="url(#glass-${id})"/>
        <rect x="50" y="105" width="140" height="75" fill="url(#glass-${id})"/>
        <path d="M120 160v-30l-4 6m4-6 4 6" fill="none" stroke="#b91c1c"/>
      </svg>
    </div>
  </section>`).join('')}
</body></html>`;

let browser;
before(async () => {
  browser = await puppeteer.launch({
    headless: 'shell',
    pipe: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
});
after(async () => { await browser?.close(); });

async function capture({ overlay, status = 200 } = {}) {
  const service = new EstimatePdfService();
  // Avoid configuration files, real authentication, databases and HTTP services.
  service.resolveFrontendUrl = () => new URL(reportUrl);
  service.logger.warn = () => {};
  const requests = [];
  let cookies;
  const result = await service.capturePieceDiagrams({
    browser: {
      newPage: async () => {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          requests.push(request.url());
          if (request.url() === reportUrl) {
            void request.respond({
              status,
              contentType: 'text/html',
              body: status === 200 ? diagramHtml : '<h1>Access denied</h1>',
            });
          } else {
            void request.abort();
          }
        });
        const waitForSelector = page.waitForSelector.bind(page);
        page.waitForSelector = async (selector, options) => {
          const element = await waitForSelector(selector, { ...options, timeout: 1000 });
          cookies = await page.cookies();
          if (overlay) {
            // A client-side dialog can appear after the SSR diagram has loaded.
            await page.evaluate((kind) => {
              const backdrop = document.createElement('div');
              backdrop.dataset.slot = `${kind}-overlay`;
              backdrop.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.5)';
              const content = document.createElement('div');
              content.dataset.slot = `${kind}-content`;
              content.style.cssText = 'position:fixed;left:60px;top:310px;z-index:50;width:180px;height:100px;background:#111';
              content.textContent = 'Dialog content';
              document.body.append(backdrop, content);
            }, overlay);
          }
          return element;
        };
        return page;
      },
    },
    estimate: { id: 9, pieces: [{ id: 77 }, { id: 78 }, { id: 79 }] },
    cookieHeader: 'session=synthetic-test-session',
  });
  assert.deepEqual(requests, [reportUrl], 'Only the intercepted fixture URL may be requested');
  return { result, cookies };
}

async function samplePixel(dataUrl, x, y) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ dataUrl, x, y }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(x, y, 1, 1).data);
    }, { dataUrl, x, y });
  } finally {
    await page.close();
  }
}

test('normal capture preserves background, frame colors, all pieces and forwarded cookies', async () => {
  const { result, cookies } = await capture();
  assert.deepEqual(Object.keys(result), ['77', '78', '79']);
  // Coordinates account for the production deviceScaleFactor of 2.
  assert.deepEqual(await samplePixel(result['77'], 4, 4), [241, 245, 249, 255]);
  assert.deepEqual(await samplePixel(result['77'], 85, 25), [68, 63, 59, 255]);
  assert.equal(cookies.find((cookie) => cookie.name === 'session')?.value, 'synthetic-test-session');
});

for (const overlay of ['dialog', 'alert-dialog', 'sheet']) {
  test(`${overlay} backdrop and content cannot darken or cover any captured diagram`, async () => {
    const baseline = (await capture()).result;
    const actual = (await capture({ overlay })).result;
    assert.deepEqual(Object.keys(actual), Object.keys(baseline));
    for (const id of Object.keys(baseline)) {
      assert.ok(actual[id] === baseline[id], `Piece ${id} differs from its unobstructed screenshot`);
    }
  });
}

for (const status of [403, 404]) {
  test(`an access-denied/not-found page (${status}) still yields no diagram`, async () => {
    assert.deepEqual((await capture({ status })).result, {});
  });
}
