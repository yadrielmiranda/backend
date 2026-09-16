import { EstimatesController } from './estimates.controller';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';
import { EstimatePdfHtmlBuilder } from './pdf/estimate-pdf-html.builder';

describe('Estimate financial refresh', () => {
  it('refreshes the order installment after adding material to an empty client estimate', async () => {
    const actor = { id: 7, role: { name: 'client' } };
    const estimate: any = {
      id: 22,
      idUser: actor.id,
      units: 0,
      status: { name: 'Active' },
      totalPayable: '0.00',
      order: null,
      payments: [],
      installationJob: null,
      paymentPlanSnapshot: {
        version: 1,
        planId: 2,
        name: 'Project 50 / 40 / 10',
        definition: {
          withInstallation: [
            { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
            { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
            { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
          ],
          withoutInstallation: [
            { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
            { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
          ],
        },
      },
    };
    const service: any = {
      findOneForUser: jest.fn(async () => ({
        ...estimate,
        paymentSchedule: buildPaymentSchedule(estimate),
      })),
    };
    const controller = new EstimatesController(
      service,
      {} as any,
      {} as any,
      {} as any,
    );
    const request: any = { user: actor };

    expect(
      (await controller.getDiscount(22, request)).paymentSchedule?.next,
    ).toBeNull();

    // El total incluye los $399.74 de material y sus $27.98 de impuesto.
    estimate.units = 2;
    estimate.totalPayable = '427.72';
    const refreshed = await controller.getDiscount(22, request);
    expect(service.findOneForUser).toHaveBeenLastCalledWith(22, actor);
    expect(refreshed.paymentSchedule?.total).toBe('427.72');
    expect(refreshed.paymentSchedule?.rows.map((row) => row.amount)).toEqual([
      '213.86',
      '213.86',
    ]);
    expect(refreshed.paymentSchedule?.next).toMatchObject({
      sequence: 1,
      milestone: 'ORDER',
      balance: '213.86',
      status: 'DUE',
    });
    expect(refreshed.config).toBeNull();
    expect(refreshed.summary).toBeNull();

    const pdfHtml = EstimatePdfHtmlBuilder.build(
      {
        ...estimate,
        number: '190931',
        name: 'Windows',
        date: new Date('2026-09-15T12:00:00Z'),
        user: {
          firstName: 'Test',
          lastName: 'Client',
          role: { name: 'client' },
        },
        pieces: [],
        priceT: '399.74',
        rateT: '300.00',
        taxRate: '0.07',
        taxAmount: '27.98',
        paymentSchedule: refreshed.paymentSchedule,
      } as any,
      'client',
    );
    expect(pdfHtml).toContain('Payment Schedule');
    expect(pdfHtml).toContain('$213.86');
    expect(pdfHtml).not.toContain('Project 50 / 40 / 10');
    expect(pdfHtml).not.toContain('Card fees');

    estimate.totalPayable = '535.00';
    expect(
      (await controller.getDiscount(22, request)).paymentSchedule?.next
        ?.balance,
    ).toBe('267.50');

    estimate.units = 0;
    estimate.totalPayable = '0.00';
    expect(
      (await controller.getDiscount(22, request)).paymentSchedule?.next,
    ).toBeNull();
  });

  it('keeps the discount response valid for estimates without a payment plan', async () => {
    const service: any = {
      findOneForUser: jest.fn(async () => ({
        manualDiscount: null,
        manualDiscountSummary: null,
      })),
    };
    const controller = new EstimatesController(
      service,
      {} as any,
      {} as any,
      {} as any,
    );
    expect(await controller.getDiscount(1, { user: { id: 7 } } as any)).toEqual(
      {
        config: null,
        summary: null,
        paymentSchedule: null,
      },
    );
  });
});
