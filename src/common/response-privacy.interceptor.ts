import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { networkSnapshot, networkPresentation, networkMaterialProfit } from '@/dealer-network/dealer-network';
import { presentInstallationPricing } from '@/installation/installation-pricing.interceptor';
import { networkAccessBlocked, networkSalesBlocked, hasExistingBusiness } from '@/dealer-network/network-access';

const credentials = new Set([
  'password', 'passwordHash', 'refreshTokenHash', 'passwordResetTokens',
  'sessions', 'passwordUpdatedAt',
]);
const companyFinancials = new Set([
  'materialProfits',
  'materialProcessingCost', 'materialProcessingCostPending',
  'processingCostSnapshot', 'processingCosts', 'processingCostSummary', 'processingComponents',
  'processingCost', 'processingCostStatus', 'netRealProfit',
  'materialFee', 'materialSurcharge', 'balanceTransactionId', 'allocationSnapshot', 'capturedAmount',
  'dealerNetworkSnapshot', 'networkPricing', 'networkBillingPriceT', 'networkRootPriceT', 'networkSubdealerPriceT', 'networkMarkup', 'networkTaxRate', 'subdealerEarnings',
  'rate', 'rateT', 'rateReal', 'netProfit', 'netProfitReal', 'markup',
  'markupOverride', 'ownerMarkupSnapshot', 'poNumber',
  'costoA', 'costoB', 'costoC', 'costPerInch',
  'installationPriceProfileId', 'installationPriceProfile',
]);
const dealerFinancials = new Set(['netProfitD', 'dealerMarkup', 'dealerMarkupDecimal', 'dealerEarnings', 'dealerEarningsPlanSnapshot', 'dealerEarningsPlanId', 'dealerEarningsPlan', 'dealerEarningsType', 'dealerEarningsPercent']);
const userFields = new Set([
  'id', 'username', 'firstName', 'lastName', 'email', 'phone', 'street',
  'parentDealerId', 'parentDealer', 'dealerLevel',
  'networkSuspended', 'networkAccessBlocked', 'networkSalesBlocked',
  'city', 'state', 'postalCode', 'role', 'idRole', 'dealerMode',
  'isActive', 'deletedAt', 'isTaxExempt', 'noInstallationDeposit',
  'createdAt', 'updatedAt',
  'markupOverride', 'paymentPlanId', 'paymentPlan',
  'dealerEarningsPlanId', 'dealerEarningsPlan',
  'installationPriceProfileId', 'installationPriceProfile',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Se aplica al límite HTTP, nunca a los objetos usados para calcular o guardar importes.
export function presentApiResponse(value: unknown, user?: AuthUser): any {
  const staff = user?.role?.name === 'admin' || user?.role?.name === 'operator';
  const dealer = user?.role?.name === 'dealer';
  const technician = user?.role?.name === 'technician';
  // Se resuelve antes del filtrado para no perder los datos internos de la cadena.
  const prepareNetwork = (input: any): any => {
    if (Array.isArray(input)) return input.map(prepareNetwork);
    if (!record(input)) return input;
    let source: any = { ...input };
    if (source.idUser != null && source.user && Array.isArray(source.payments)) {
      source.networkPaymentBlocked = networkSalesBlocked(source.user) && !hasExistingBusiness(source);
    }
    const estimate: any = source.dealerNetworkSnapshot ? source : source.estimate?.dealerNetworkSnapshot ? source.estimate : null;
    const snapshot = estimate ? networkSnapshot(estimate) : null;
    if (snapshot) {
      const canPay = snapshot.payerType === 'ACCOUNT_OWNER' && user?.id === snapshot.billingAccountId;
      const internalMember = snapshot.nodes.some(node => node.id === user?.id && node.mode === 'INTERNAL');
      if (source.dealerNetworkSnapshot || source.estimate?.dealerNetworkSnapshot) {
        source.dealerNetwork = { ...networkPresentation(estimate), canPay,
          canAssist: staff || snapshot.nodes.some(node => node.id === user?.id),
          viewerIsOwner: user?.id === estimate.idUser,
          materialProfit: networkMaterialProfit(estimate, user?.id, (source.manualDiscountSummary ?? estimate.manualDiscountSummary)?.material?.netDiscount ?? 0),
          canRecordManualPayment: user?.role?.name === 'admin' || internalMember };
      }
      if (source.user?.id === estimate.idUser) source.user = { ...source.user, dealerLevel: snapshot.nodes.at(-1)!.level };
      if (!staff) {
        if (user?.id === snapshot.nodes[1].id && snapshot.subdealerPlan) source.dealerEarnings = source.subdealerEarnings ?? null;
        else if (user?.id !== snapshot.nodes[0].id) source.dealerEarnings = null;
      }
      if (!staff && !canPay && !internalMember) {
        source.paymentSchedule = null;
        source.paymentPlanSnapshot = null;
        source.manualDiscount = null;
        source.manualDiscountSummary = null;
        source.payments = Array.isArray(source.payments) ? source.payments.map((payment: any) => ({
          id: payment.id, status: payment.status, type: payment.type, sequence: payment.sequence,
          paidAt: payment.paidAt, stripeSessionId: payment.stripeSessionId,
          refundReviewPending: payment.refundReviewPending,
        })) : source.payments;
        if (source.estimate) {
          source.amount = estimate.totalPayable;
          source.price = estimate.priceT;
          source.saleSubtotal = estimate.priceT;
          source.payment = undefined;
        }
      }
    }
    if ('username' in source && source.role?.name === 'dealer') {
      source.networkAccessBlocked = networkAccessBlocked(source);
      source.networkSalesBlocked = networkSalesBlocked(source);
      source.dealerLevel = source.dealerLevel ?? (source.parentDealerId == null ? 'DEALER'
        : source.parentDealer?.parentDealerId == null ? 'SUBDEALER' : 'DISTRIBUTOR');
    }
    return Object.fromEntries(Object.entries(source).map(([key, child]) => [key, prepareNetwork(child)]));
  };
  const prepared = prepareNetwork(value);
  const source = staff ? prepared : presentInstallationPricing(prepared, user);
  const visit = (input: unknown): any => {
    if (Array.isArray(input)) return input.map(visit);
    // Conserva Decimal, Date, Buffer y respuestas de archivos sin transformarlos.
    if (!record(input)) return input;
    const isUser = 'username' in input && ('idRole' in input || 'password' in input);
    return Object.fromEntries(Object.entries(input)
      .filter(([key]) => !credentials.has(key) && (!isUser || userFields.has(key)) &&
        (user?.role?.name === 'admin' || (key !== 'coverageSnapshot' && key !== 'estimatedMinutes' && key !== 'timeSnapshot')) &&
        (staff || (technician && key === 'poNumber') || !companyFinancials.has(key)) &&
        (staff || dealer || !dealerFinancials.has(key)))
      .map(([key, child]) => [key, visit(child)]));
  };
  return visit(source);
}

@Injectable()
export class ResponsePrivacyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    return next.handle().pipe(map((value) => presentApiResponse(value, user)));
  }
}
