import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { presentInstallationPricing } from '@/installation/installation-pricing.interceptor';

const credentials = new Set([
  'password', 'passwordHash', 'refreshTokenHash', 'passwordResetTokens',
  'sessions', 'passwordUpdatedAt',
]);
const companyFinancials = new Set([
  'rate', 'rateT', 'rateReal', 'netProfit', 'netProfitReal', 'markup',
  'markupOverride', 'ownerMarkupSnapshot', 'poNumber',
  'costoA', 'costoB', 'costoC', 'costPerInch',
  'installationPriceProfileId', 'installationPriceProfile',
]);
const dealerFinancials = new Set(['netProfitD', 'dealerMarkup', 'dealerMarkupDecimal']);
const userFields = new Set([
  'id', 'username', 'firstName', 'lastName', 'email', 'phone', 'street',
  'city', 'state', 'postalCode', 'role', 'idRole', 'dealerMode',
  'isActive', 'deletedAt', 'isTaxExempt', 'noInstallationDeposit',
  'createdAt', 'updatedAt',
  'markupOverride', 'paymentPlanId', 'paymentPlan',
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
  const source = staff ? value : presentInstallationPricing(value, user);
  const visit = (input: unknown): any => {
    if (Array.isArray(input)) return input.map(visit);
    // Conserva Decimal, Date, Buffer y respuestas de archivos sin transformarlos.
    if (!record(input)) return input;
    const isUser = 'username' in input && ('idRole' in input || 'password' in input);
    return Object.fromEntries(Object.entries(input)
      .filter(([key]) => !credentials.has(key) && (!isUser || userFields.has(key)) &&
        (user?.role?.name === 'admin' || (key !== 'coverageSnapshot' && key !== 'estimatedMinutes' && key !== 'timeSnapshot')) &&
        (staff || !companyFinancials.has(key)) &&
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
