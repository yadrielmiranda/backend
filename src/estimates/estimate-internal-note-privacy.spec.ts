import type { AuthUser } from '@/auth/types/auth-user.type';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { agreementContent, agreementScopes, canonicalJson, sha256 } from '@/contracts/agreement-content';
import { agreementQuoteReport, changeOrderHtml, ContractPdfService } from '@/contracts/contract-pdf.service';
import type { PdfView } from './estimates.service';
import { materialRevisionBaseHash } from './material-revisions/material-revision-snapshot';
import { EstimatePdfHtmlBuilder } from './pdf/estimate-pdf-html.builder';
import { buildPublicEstimateData } from './public-share/public-estimate-data';

const secret = 'PRIVATE-NOTE-DO-NOT-PUBLISH';
const note = () => ({
  text: secret,
  version: 1,
  updatedAt: new Date('2026-10-23T14:00:00Z'),
  updatedBy: { id: 7, name: 'Private editor' },
});

function estimateFixture(): any {
  return {
    id: 41, idUser: 7, number: '190041', name: 'Project',
    date: new Date('2026-10-22T12:00:00Z'),
    customerFirstName: 'Sample', customerLastName: 'Customer',
    user: { id: 7, role: { name: 'dealer' }, dealerMode: 'EXTERNAL' },
    status: { name: 'Active' }, dealerModeSnapshot: 'EXTERNAL',
    rateT: '600.00', priceT: '800.00', taxRate: '.07', taxAmount: '56.00',
    totalPayable: '856.00', customerPriceT: '1000.00', customerTaxRate: '.07',
    customerTaxAmount: '70.00', customerTotalPayable: '1070.00',
    installationJob: null, customerCharges: [], payments: [], pieces: [],
  };
}

describe('Internal estimate note privacy', () => {
  it.each(['client', 'technician', 'unknown', undefined])(
    'removes notes from every nested response for %s', (role) => {
      const original = {
        internalNote: note(),
        estimate: { id: 41, internalNote: note() },
        orders: [{ estimate: { id: 41, internalNote: note() } }],
      };
      const actor = role ? { id: 7, role: { name: role } } as AuthUser : undefined;
      const result = presentApiResponse(original, actor);
      expect(result).toEqual({ estimate: { id: 41 }, orders: [{ estimate: { id: 41 } }] });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(original.estimate.internalNote.text).toBe(secret);
    },
  );

  it.each(['admin', 'operator', 'dealer'] as const)(
    'preserves an authorized note response for %s', (role) => {
      const response = { internalNote: note(), canEdit: role !== 'operator' };
      const result = presentApiResponse(response, { id: 7, role: { name: role } });
      expect(result).toEqual(response);
      expect(result).not.toBe(response);
      expect(result.internalNote).not.toBe(response.internalNote);
    },
  );

  it.each(['detailed', 'total'] as const)(
    'keeps the %s public quote, agreement and signature hashes unchanged', (mode) => {
      const estimate = estimateFixture();
      const before = buildPublicEstimateData(estimate, null, estimate.pieces, mode);
      const beforeHash = sha256(canonicalJson(agreementContent(before)));
      const beforeScope = agreementScopes(before);
      const materialHash = materialRevisionBaseHash(estimate);

      for (const internalNote of [note(), { ...note(), text: 'Edited ' + secret, version: 2 }, null]) {
        const withNote = { ...estimate, internalNote };
        const after = buildPublicEstimateData(withNote, null, estimate.pieces, mode);
        expect(after).toEqual(before);
        expect(JSON.stringify(after)).not.toContain(secret);
        expect(sha256(canonicalJson(agreementContent(after)))).toBe(beforeHash);
        expect(agreementScopes(after)).toEqual(beforeScope);
        expect(materialRevisionBaseHash(withNote)).toBe(materialHash);
        const html = EstimatePdfHtmlBuilder.build(
          agreementQuoteReport(after), mode === 'total' ? 'dealer_public_total' : 'dealer_public',
        );
        expect(html).not.toContain(secret);
      }
    },
  );

  it.each<PdfView>(['admin', 'dealer_internal', 'dealer_public', 'dealer_public_total', 'client'])(
    'excludes the note from the %s PDF even when fetched for an authorized admin', (view) => {
      const estimate = estimateFixture();
      const before = EstimatePdfHtmlBuilder.build(estimate, view, {}, 99, 'admin');
      const beforeFooter = EstimatePdfHtmlBuilder.buildFooterTemplate(estimate, view);
      const withNote = { ...estimate, internalNote: note() };
      const after = EstimatePdfHtmlBuilder.build(withNote, view, {}, 99, 'admin');
      const afterFooter = EstimatePdfHtmlBuilder.buildFooterTemplate(withNote, view);
      expect(after).toBe(before);
      expect(afterFooter).toBe(beforeFooter);
      expect(after + afterFooter).not.toContain(secret);
    },
  );

  it('excludes the note from change-order documents', () => {
    const snapshot = {
      ...estimateFixture(),
      changeOrder: {
        number: 1, baseRevision: 1, items: [], changedCharges: [],
        previousTotal: '1070.00', newTotal: '1170.00', difference: '100.00',
      },
    };
    const original = changeOrderHtml(snapshot);
    const withNote = changeOrderHtml({ ...snapshot, internalNote: note() });
    expect(withNote).toBe(original);
    expect(withNote).not.toContain(secret);
  });

  it('keeps the electronic acceptance receipt unchanged after a note edit', async () => {
    const page = { setContent: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
    const service = new ContractPdfService();
    jest.spyOn(service as any, 'browser').mockImplementation(async (work: any) =>
      work({ newPage: async () => page }),
    );
    const agreement = {
      snapshot: estimateFixture(), pricingMode: 'detailed', contract: { name: 'Dealer terms' },
    };
    const params = {
      agreement, signerName: 'Sample Customer', strokes: [[{ x: .1, y: .2 }, { x: .3, y: .4 }]],
      signedAt: new Date('2026-10-23T13:00:00Z'),
    };
    await service.receipt(params);
    agreement.snapshot.internalNote = note();
    await service.receipt(params);
    const [before, after] = page.setContent.mock.calls.map(([html]) => html);
    expect(after).toBe(before);
    expect(after).not.toContain(secret);
  });
});
