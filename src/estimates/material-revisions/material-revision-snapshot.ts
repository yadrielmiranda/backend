import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import type { CalculatedPieceCombined } from '@/estimates/calculation/estimate-piece-calculator.service';
import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import { scheduleAmounts } from '@/payment-plans/payment-schedule';
import { sumAmounts } from '@/payment-plans/payment-plan';
import { decimalAmount, paidPrincipal } from '@/payments/payment-accounting';

export type MaterialRevisionItemSnapshot = {
  key: string;
  action: 'ADD' | 'UPDATE';
  originalPieceId: number | null;
  input: CreatePieceDto;
  pricing: any;
  label: string;
  originalLabel: string | null;
  changeDescription: string[];
};
export type MaterialRevisionProposal = {
  pieces: any[];
  totals: Record<string, any>;
  installation: any | null;
  paymentPlanSnapshot?: any;
};

export function revisionJson<T = any>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
// Los cobros y la bitácora no cambian la huella; sí los importes/especificaciones acordados.
export function materialRevisionBaseHash(estimate: any): string {
  const pieces = (estimate.pieces ?? []).map((piece: any) => {
    const { createdAt, updatedAt, factoryUnits, prod, bran, syst, conf, fColor, cryst, tin, coat, privacyOption, activeOption, preparationOption, sillOption, reinforcementOption, pieceMuntin, ...content } = piece;
    return { ...content, pieceMuntin: pieceMuntin ? { patternId: pieceMuntin.patternId, typeId: pieceMuntin.typeId, totalLites: pieceMuntin.totalLites, panels: pieceMuntin.panels.map((panel: any) => ({ panelIndex: panel.panelIndex, panelCode: panel.panelCode, horizontalLites: panel.horizontalLites, verticalLites: panel.verticalLites })) } : null }; 
  });
  const quote = estimate.installationJob?.quotes?.[0];
  const content = revisionJson({
    idUser: estimate.idUser,
    pieces,
    totals: Object.fromEntries(['units', 'rateT', 'priceT', 'customerPriceT', 'taxRate', 'customerTaxRate', 'totalPayable', 'customerTotalPayable', 'manualDiscount', 'ownerMarkupSnapshot', 'dealerModeSnapshot', 'dealerEarningsPlanSnapshot', 'paymentPlanSnapshot'].map(key => [key, estimate[key]])),
    customer: Object.fromEntries(['name', 'customerFirstName', 'customerLastName', 'customerEmail', 'customerPhone', 'customerStreet', 'customerCity', 'customerState', 'customerPostalCode'].map(key => [key, estimate[key]])),
    installation: estimate.installationJob ? {
      id: estimate.installationJob.id, canceled: estimate.installationJob.status === 'CANCELED',
      address: estimate.installationJob.installationAddress,
      quote: quote ? { id: quote.id, version: quote.version, status: quote.status, total: quote.total, updatedAt: quote.updatedAt } : null,
      measurements: (estimate.installationJob.measurements ?? []).map((m: any) => ({ id: m.id, updatedAt: m.updatedAt })),
      permit: estimate.installationJob.permit,
    } : null,
    customerCharges: estimate.customerCharges,
  });
  return createHash('sha256').update(stable(content)).digest('hex');
}

// Un cambio sin diferencia de tarifa conserva exactamente el precio histórico,
// aunque el catálogo se haya actualizado desde que se acordó la pieza.
export function preserveAgreedPiecePrices(original: any, before: CalculatedPieceCombined, after: CalculatedPieceCombined): CalculatedPieceCombined {
  const delta = (key: 'rate' | 'price' | 'customerPrice' | 'regularPrice' | 'regularCustomerPrice') => {
    const fallback = key === 'regularPrice' ? 'price' : key === 'regularCustomerPrice' ? 'customerPrice' : key;
    const saved = original[key] == null || (key.startsWith('regular') && Number(original[key]) === 0)
      ? original[fallback] : original[key];
    const value = new Decimal(String(saved)).add(after[key] ?? after[fallback]).sub(before[key] ?? before[fallback]).toDecimalPlaces(2);
    if (value.lt(0)) throw new BadRequestException('The revision would produce a negative unit price. Review the original pricing.');
    return value;
  };
  const rate = delta('rate'), price = delta('price'), customerPrice = delta('customerPrice');
  return {
    ...after, rate, price, customerPrice,
    regularPrice: delta('regularPrice'), regularCustomerPrice: delta('regularCustomerPrice'),
    subtotal: price.mul(after.qty).toDecimalPlaces(2),
    customerSubtotal: customerPrice.mul(after.qty).toDecimalPlaces(2),
    netProfit: price.sub(rate).toDecimalPlaces(2),
    netProfitD: customerPrice.sub(price).mul(after.qty).toDecimalPlaces(2),
  };
}

export function revisionProjectSummary(estimate: any) {
  const amounts = scheduleAmounts(estimate);
  const payerTotal = sumAmounts(amounts);
  const customer = buildPublicEstimateData(estimate, null, estimate.pieces ?? [], 'total');
  const payments = (estimate.payments ?? []).filter((payment: any) =>
    ['MATERIAL', 'INSTALLMENT', 'INSTALLATION_DEPOSIT', 'INSTALLATION', 'PERMIT'].includes(payment.type));
  const paid = payments.reduce((sum: Decimal, payment: any) => sum.add(paidPrincipal(payment)), new Decimal(0));
  const credits = payments.reduce((sum: Decimal, payment: any) => sum.add(decimalAmount(payment.refundCreditAmount)), new Decimal(0));
  return {
    material: amounts.material,
    installation: amounts.installation,
    servicesAndFees: new Decimal(amounts.permit).add(amounts.city).toFixed(2),
    projectTotal: payerTotal.toFixed(2),
    customerProjectTotal: new Decimal(String(customer.publicProjectTotal)).toFixed(2),
    paid: paid.toFixed(2), approvedCredit: credits.toFixed(2),
    balance: Decimal.max(0, payerTotal.sub(paid).sub(credits)).toFixed(2),
    creditBalance: Decimal.max(0, paid.add(credits).sub(payerTotal)).toFixed(2),
    provisionalInstallation: Boolean(estimate.installationJob && estimate.installationJob.status !== 'CANCELED' && estimate.installationJob.quotes?.[0]?.status !== 'APPROVED'),
    customerTotalIncomplete: customer.publicProjectTotalIncomplete,
  };
}

// Únicamente el visor de contratos utiliza esta proyección. El estimado/orden
// vigente y sus PDFs normales no cambian mientras falte la aceptación/firma.
export function projectMaterialRevision(estimate: any, revision: any) {
  if (!revision?.proposal) return estimate;
  const proposal = revision.proposal as MaterialRevisionProposal;
  return {
    ...estimate, ...proposal.totals, pieces: proposal.pieces,
    ...(proposal.paymentPlanSnapshot ? { paymentPlanSnapshot: proposal.paymentPlanSnapshot } : {}),
    installationJob: proposal.installation && estimate.installationJob ? {
      ...estimate.installationJob,
      status: proposal.installation.status,
      quotes: [proposal.installation.quote],
    } : estimate.installationJob,
  };
}
