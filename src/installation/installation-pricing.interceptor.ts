import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import Decimal from 'decimal.js';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { buildEstimateInstallationSummary } from '@/estimates/reporting/estimate-installation-summary';

type RecordValue = Record<string, any>;

const pick = (value: RecordValue, keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => key in value).map((key) => [key, value[key]]),
  );

function record(value: unknown): value is RecordValue {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

const internalFields = new Set([
  'rate',
  'rateT',
  'rateReal',
  'netProfit',
  'netProfitReal',
  'markup',
  'markupOverride',
  'installationPriceProfileId',
]);
const credentialFields = new Set([
  'password',
  'passwordHash',
  'refreshTokenHash',
]);

function publicQuote(quote: RecordValue, user: AuthUser | undefined) {
  const lines = quote.lines.map((line: RecordValue) => {
    const quantity = Math.max(1, Number(line.occurrences) || 1);
    const requested = line.origin === 'USER_SELECTED';
    return {
      ...pick(line, [
        'id',
        'quoteId',
        'serviceId',
        'measurementId',
        'serviceNameSnapshot',
        'componentLabel',
        'description',
        'sortOrder',
        'occurrences',
        'adjustedAmount',
      ]),
      // Conserva las medidas ingresadas para poder editar una solicitud pendiente.
      ...(requested
        ? pick(line, [
            'widthIn',
            'heightIn',
            'areaSqFt',
            'panelCount',
            'lengthIn',
          ])
        : {}),
      unitPrice: new Decimal(String(line.adjustedAmount))
        .div(quantity)
        .toFixed(6),
      isRequestedService: requested,
      canRemove:
        quote.status === 'DRAFT' &&
        (requested ||
          (user?.role?.name === 'operator' && line.origin === 'FIELD_ADDED')),
    };
  });
  const linesTotal = lines.reduce(
    (sum: Decimal, line: RecordValue) => sum.add(String(line.adjustedAmount)),
    new Decimal(0),
  );
  const summary = buildEstimateInstallationSummary({
    status: 'REQUESTED',
    quotes: [quote],
    permit: null,
  } as Parameters<typeof buildEstimateInstallationSummary>[0]);

  return {
    ...pick(quote, [
      'id',
      'jobId',
      'version',
      'status',
      'approvalReason',
      'total',
      'needsRecalculation',
      'notes',
      'submittedAt',
      'approvedAt',
      'createdAt',
      'updatedAt',
      'approvals',
    ]),
    pricingDetailsVisible: false,
    lines,
    additionalServices: summary?.additionalServices ?? [],
    // Muestra el importe restante sin revelar las reglas de mínimos que lo originaron.
    additionalInstallationCharge: Decimal.max(
      0,
      new Decimal(String(quote.total)).minus(linesTotal),
    ).toFixed(2),
  };
}

export function presentInstallationPricing(
  value: unknown,
  user?: AuthUser,
): any {
  const admin = user?.role?.name === 'admin';
  const visit = (input: unknown): any => {
    if (Array.isArray(input)) return input.map(visit);
    if (!record(input)) return input;
    let source = input;
    if (Array.isArray(input.lines) && 'profileNameSnapshot' in input) {
      source = admin
        ? { ...input, pricingDetailsVisible: true }
        : publicQuote(input, user);
    } else if (!admin && 'billingUnit' in input && 'baseRate' in input) {
      // Las medidas requeridas siguen disponibles para solicitar servicios; sus tarifas no.
      source = pick(input, [
        'id',
        'name',
        'description',
        'billingUnit',
        'ruleMetric',
        'availableForRequest',
        'availableForField',
        'isActive',
        'sortOrder',
      ]);
    }
    return Object.fromEntries(
      Object.entries(source)
        .filter(
          ([key]) =>
            !credentialFields.has(key) && (admin || !internalFields.has(key)),
        )
        .map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(value);
}

@Injectable()
export class InstallationPricingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    // Solo transforma la respuesta HTTP; los cálculos y las transacciones conservan sus datos.
    return next
      .handle()
      .pipe(map((value) => presentInstallationPricing(value, user)));
  }
}
