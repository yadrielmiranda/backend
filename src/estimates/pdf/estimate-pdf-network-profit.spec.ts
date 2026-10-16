import puppeteer from 'puppeteer';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { buildNetworkProfitBreakdown, type NetworkProfitBreakdown } from '@/common/network-profit-breakdown';
import type { EstimateWithRelations, PdfView } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';
import { EstimatePdfService } from './estimate-pdf.service';

jest.mock('@/common/network-profit-breakdown', () => ({ buildNetworkProfitBreakdown: jest.fn() }));
jest.mock('puppeteer', () => ({ __esModule: true, default: { launch: jest.fn() } }));

const estimateFixture = () => ({
  id: 19, idUser: 3, number: 190919, name: 'Network example',
  date: new Date('2026-10-01T12:00:00Z'), customerFirstName: 'Sample', customerLastName: 'Customer',
  priceT: '1500.00', customerPriceT: '1700.00', taxRate: '0', customerTaxRate: '0',
  taxAmount: '0', customerTaxAmount: '0', totalPayable: '1500.00', customerTotalPayable: '1700.00',
  rateT: '1000.00', netProfitD: '200.00', dealerModeSnapshot: 'EXTERNAL',
  networkRootPriceT: '1200.00', networkSubdealerPriceT: '1300.00', networkBillingPriceT: '1500.00',
  user: { id: 3, firstName: 'Distributor', lastName: 'Example', role: { name: 'dealer' } },
  branding: { name: 'Company example' }, pieces: [], installationSummary: null,
  order: { saleSubtotal: '1500.00', rate: '1000.00', rateReal: '950.00' },
  dealerNetworkSnapshot: {
    version: 1, rootMode: 'INTERNAL', rootMarkup: '0.2', payerType: 'ACCOUNT_OWNER',
    billingIndex: 2, billingAccountId: 3, billingTaxRate: '0',
    payer: { name: 'Distributor Example', email: null, phone: null },
    nodes: [
      { id: 1, username: 'Grandparent dealer', level: 'DEALER', markup: '0', mode: 'INTERNAL' },
      { id: 2, username: 'Parent subdealer', level: 'SUBDEALER', markup: '0.1', mode: 'INTERNAL' },
      { id: 3, username: 'Owner distributor', level: 'DISTRIBUTOR', markup: '0.1', mode: 'EXTERNAL' },
    ],
    earningsPlan: { version: 2, planId: 1, name: 'Saved plan', revision: 1, basis: 'DEALER_MARKUP', percent: '100' },
    subdealerPlan: { mode: 'MARKUP', percent: '100' },
  },
  customerChargesSummary: {
    enabled: true, systemTotal: '2000.00', customerTotal: '2300.00',
    systemTotalIncomplete: false, customerTotalIncomplete: false, lines: [],
  },
}) as unknown as EstimateWithRelations;

const calculated = (amount: string) => ({ amount, status: 'CALCULATED' as const });
const breakdownFixture = (): NetworkProfitBreakdown => ({
  version: 1,
  members: [
    { userId: 3, username: 'Owner distributor', level: 'DISTRIBUTOR', mode: 'EXTERNAL', material: calculated('211.25'), services: calculated('300.00'), total: calculated('511.25') },
    { userId: 2, username: 'Parent subdealer', level: 'SUBDEALER', mode: 'INTERNAL', material: calculated('103.10'), services: calculated('0.00'), total: calculated('103.10') },
    { userId: 1, username: 'Grandparent dealer', level: 'DEALER', mode: 'INTERNAL', material: calculated('97.65'), services: calculated('0.00'), total: calculated('97.65') },
  ],
  company: { materialExpected: calculated('188.90'), materialReal: calculated('238.90'), installation: calculated('400.00'), expectedTotal: calculated('588.90') },
});

const breakdownHtml = (html: string) => html.match(/<section class="card network-profit[\s\S]*?<\/section>/)?.[0];
const mockBreakdown = jest.mocked(buildNetworkProfitBreakdown);

describe('Administrative PDF participant profit breakdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBreakdown.mockReturnValue(breakdownFixture());
  });

  it('shows all saved participants separately and preserves the material financial summary', () => {
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin', {}, 99, 'admin');
    const table = breakdownHtml(html)!;
    expect(table).toContain('Profit by participant');
    expect(table).toContain('Owner distributor');
    expect(table).toContain('Parent subdealer');
    expect(table).toContain('Grandparent dealer');
    expect(table.indexOf('Owner distributor')).toBeLessThan(table.indexOf('Parent subdealer'));
    expect(table.indexOf('Parent subdealer')).toBeLessThan(table.indexOf('Grandparent dealer'));
    for (const amount of ['$211.25', '$511.25', '$103.10', '$97.65', '$188.90', '$400.00', '$588.90']) expect(table).toContain(amount);
    expect(table).toContain('Company');
    expect(table).toContain('Estimated');
    expect(table).toContain('Sales tax excluded.');
    expect(table).toContain('before card processing fees');
    expect(table).toContain('other service margins are not included');
    expect(html).toContain('Material financial summary');
    expect(html).not.toContain('<section class="dealer-profit');
    expect(mockBreakdown).toHaveBeenCalledTimes(1);
  });

  it('uses the server-built breakdown when the PDF estimate has reduced installation details', () => {
    const estimate = estimateFixture();
    estimate.networkProfitBreakdown = breakdownFixture();
    estimate.networkProfitBreakdown.company.installation = calculated('456.78');
    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin', {}, 99, 'admin');
    expect(breakdownHtml(html)).toContain('$456.78');
    expect(mockBreakdown).not.toHaveBeenCalled();
  });

  it.each(['operator', 'dealer', 'client', 'technician', undefined, ''])('does not expose the new breakdown to role %s, even in the admin view', (role) => {
    const estimate = estimateFixture();
    estimate.networkProfitBreakdown = breakdownFixture();
    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin', {}, 99, role);
    expect(breakdownHtml(html)).toBeUndefined();
    expect(html).not.toContain('Owner distributor');
    expect(mockBreakdown).not.toHaveBeenCalled();
    expect(html).toContain('<section class="dealer-profit');
  });

  it.each<PdfView>(['dealer_internal', 'dealer_public', 'dealer_public_total', 'client'])('keeps the %s report unchanged even when printed by an admin', (view) => {
    const estimate = estimateFixture();
    estimate.networkProfitBreakdown = breakdownFixture();
    const html = EstimatePdfHtmlBuilder.build(estimate, view, {}, 3, 'admin');
    expect(breakdownHtml(html)).toBeUndefined();
    expect(html).not.toContain('Grandparent dealer');
    expect(html).not.toContain('$588.90');
    expect(mockBreakdown).not.toHaveBeenCalled();
  });

  it('preserves legacy earnings cards if there is no participant breakdown', () => {
    mockBreakdown.mockReturnValue(null);
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin', {}, 99, 'admin');
    expect(breakdownHtml(html)).toBeUndefined();
    expect(html).toContain('<section class="dealer-profit');
    expect(html).toContain('Subdealer material earnings');
  });

  it('escapes participant names and distinguishes pending amounts, losses and actual zero', () => {
    const report = breakdownFixture();
    report.members[0].username = '<script>alert("x")</script> & Company';
    report.members[0].material = { amount: null, status: 'PENDING_REVIEW' };
    report.members[0].total = { amount: null, status: 'PENDING_REVIEW' };
    report.members[1].material = { amount: null, status: 'PENDING_REAL_COST' };
    report.members[1].total = { amount: null, status: 'PENDING_REAL_COST' };
    report.members[2].material = calculated('-12.50');
    report.members[2].total = calculated('-12.50');
    report.company.materialExpected = { amount: null, status: 'PENDING_COST' };
    report.company.expectedTotal = { amount: null, status: 'PENDING_COST' };
    mockBreakdown.mockReturnValue(report);
    const table = breakdownHtml(EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin', {}, 99, 'admin'))!;
    expect(table).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Company');
    expect(table).not.toContain('<script>');
    expect(table).toContain('Pending review');
    expect(table).toContain('Pending real factory cost');
    expect(table).toContain('Pending processing cost confirmation');
    expect(table).toContain('<span class="loss">-$12.50</span>');
    expect(table).toContain('<span>$0.00</span>');
  });

  it.each(['admin', 'operator'] as const)('passes the authenticated %s role into the builder without changing existing PDF access', async (role) => {
    const page = { setContent: jest.fn(), emulateMediaType: jest.fn(), evaluate: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
    const browser = { newPage: jest.fn().mockResolvedValue(page), close: jest.fn() };
    jest.mocked(puppeteer.launch).mockResolvedValue(browser as never);
    const build = jest.spyOn(EstimatePdfHtmlBuilder, 'build');
    const estimate = estimateFixture();
    const user: AuthUser = { id: 99, role: { name: role } };
    const service = new EstimatePdfService();
    await expect(service.generateEstimatePdfBuffer({ estimate, user, view: 'admin' })).resolves.toEqual(Buffer.from('pdf'));
    expect(build).toHaveBeenCalledWith(estimate, 'admin', {}, 99, role);
    const html = page.setContent.mock.calls[0][0] as string;
    expect(Boolean(breakdownHtml(html))).toBe(role === 'admin');
    expect(browser.close).toHaveBeenCalledTimes(1);
    build.mockRestore();
  });

  it.each(['dealer', 'client', 'technician'] as const)('continues rejecting an admin PDF requested by %s', async (role) => {
    const service = new EstimatePdfService();
    await expect(service.generateEstimatePdfBuffer({ estimate: estimateFixture(), user: { id: 3, role: { name: role } }, view: 'admin' })).rejects.toThrow(/not allowed/);
    expect(puppeteer.launch).not.toHaveBeenCalled();
  });
});
