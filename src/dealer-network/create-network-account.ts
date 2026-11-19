import { Prisma } from '@prisma/client';
import { normalizeAddressLine2 } from '@/common/address-line2';

// Both the stored fraction and the editable percentage can contain 24 significant digits.
const MarkupDecimal = Prisma.Decimal.clone({ precision: 24 });

export function networkMarkupPercent(markup: Prisma.Decimal): Prisma.Decimal {
  return new MarkupDecimal(markup).mul(100);
}

export function networkMarkupFraction(percent: Prisma.Decimal): Prisma.Decimal {
  return new MarkupDecimal(percent).div(100);
}

/** Used for both manual network accounts and approved applications. */
export async function createNetworkAccount(
  tx: Prisma.TransactionClient,
  data: Prisma.UserUncheckedCreateInput,
) {
  return tx.user.create({
    data: {
      ...data,
      addressLine2: normalizeAddressLine2(data.addressLine2),
      isTaxExempt: false,
      noInstallationDeposit: false,
    },
    select: { id: true, username: true, parentDealerId: true },
  });
}
