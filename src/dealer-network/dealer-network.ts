import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import { loadActiveEarningsPlan, type EarningsPlanSnapshot } from '@/earnings-plans/earnings-plan';

export type NetworkLevel = 'DEALER' | 'SUBDEALER' | 'DISTRIBUTOR';
export const NETWORK_LABELS = ['Dealer', 'Subdealer', 'Distributor'] as const;
export type NetworkSnapshot = {
  version: 1;
  rootMode: 'INTERNAL' | 'EXTERNAL';
  rootMarkup: string;
  nodes: Array<{ id: number; username: string; level: NetworkLevel; markup: string; taxRate?: string; mode: 'INTERNAL' | 'EXTERNAL' }>;
  payerType: 'ACCOUNT_OWNER' | 'CUSTOMER';
  subdealerPlan: { mode: 'AVAILABLE_PROFIT' | 'MARKUP'; percent: string } | null;
  billingIndex: number;
  billingAccountId: number;
  billingTaxRate: string;
  payer: { name: string; email: string | null; phone: string | null };
  earningsPlan: EarningsPlanSnapshot | null;
};
export type NetworkPiecePricing = { version: 1; billingIndex: number; prices: string[]; regularPrices: string[] };
export const networkSnapshot = (estimate: any): NetworkSnapshot | null => {
  const value = estimate?.dealerNetworkSnapshot;
  if (value == null) return null;
  if (value.version !== 1 || !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 3 ||
      !Number.isInteger(value.billingIndex) || value.billingIndex < 0 || value.billingIndex > value.nodes.length ||
      (value.billingIndex < value.nodes.length ? value.nodes[value.billingIndex]?.id : value.nodes.at(-1)?.id) !== value.billingAccountId)
    throw new BadRequestException('Invalid saved dealer network.');
  return value as NetworkSnapshot;
};

// Consulta acotada a tres niveles; no depende de un nivel enviado por el navegador.
export async function dealerChain(db: Prisma.TransactionClient, ownerId: number) {
  const chain: Array<Prisma.UserGetPayload<{ include: { role: true } }>> = [];
  let id: number | null = ownerId;
  while (id != null) {
    if (chain.length === 3 || chain.some(user => user.id === id))
      throw new BadRequestException('The dealer network supports three levels and cannot contain cycles.');
    const user = await db.user.findUnique({ where: { id }, include: { role: true } });
    if (!user || user.role.name !== 'dealer') throw new BadRequestException('Invalid dealer network account.');
    chain.unshift(user);
    id = user.parentDealerId ?? null;
  }
  if (chain[2]?.dealerMode !== undefined && chain[2].dealerMode !== 'EXTERNAL')
    throw new BadRequestException('Distributors must be external dealers.');
  if (chain[1]?.dealerMode === 'INTERNAL' && chain[0].dealerMode !== 'INTERNAL')
    throw new BadRequestException('Internal subdealers require an internal parent dealer.');
  if (chain.slice(1).some(user => user.dealerEarningsPlanId != null))
    throw new BadRequestException('Network accounts use their parent dealer earnings arrangement.');
  return chain;
}

// Cada venta usa su propia tasa; nunca hereda el impuesto pagado por el superior.
export function networkAccountTaxRate(account: {
  parentDealerId?: number | null;
  networkTaxRate?: { toString(): string } | null;
  isTaxExempt?: boolean;
}, salesTax: Decimal.Value): Decimal {
  if (account.parentDealerId != null && account.networkTaxRate != null)
    return new Decimal(account.networkTaxRate.toString());
  return new Decimal(account.isTaxExempt ? 0 : salesTax);
}

export async function createNetworkSnapshot(db: Prisma.TransactionClient, owner: any, salesTax: Decimal.Value): Promise<NetworkSnapshot | null> {
  if (owner.role?.name !== 'dealer') return null;
  if (owner.networkSuspended) throw new BadRequestException('New business is paused for this dealer.');
  if (!owner.parentDealerId) return null;
  const chain = await dealerChain(db, owner.id);
  if (chain.some(user => !user.isActive || user.deletedAt || user.networkSuspended)) throw new BadRequestException('A dealer in this network is inactive or suspended.');
  const root = chain[0];
  const externalIndex = chain.findIndex(user => user.dealerMode !== 'INTERNAL');
  const billingIndex = externalIndex < 0 ? chain.length : externalIndex;
  const payer = chain[Math.min(billingIndex, chain.length - 1)];
  const subdealer = chain[1];
  const subdealerPlan = subdealer.dealerMode === 'INTERNAL'
    ? validateSubdealerPlan(subdealer.subdealerEarningsMode, subdealer.subdealerEarningsPercent?.toString()) : null;
  const levels: NetworkLevel[] = ['DEALER', 'SUBDEALER', 'DISTRIBUTOR'];
  return {
    version: 1, rootMode: root.dealerMode ?? 'EXTERNAL',
    rootMarkup: String(root.markupOverride ?? root.role.markup),
    nodes: chain.map((user, index) => ({ id: user.id, username: user.username, level: levels[index], markup: String(index ? user.networkMarkup : 0), taxRate: networkAccountTaxRate(user, salesTax).toString(), mode: user.dealerMode ?? 'EXTERNAL' })),
    payerType: externalIndex < 0 ? 'CUSTOMER' : 'ACCOUNT_OWNER', subdealerPlan,
    billingIndex, billingAccountId: payer.id,
    billingTaxRate: networkAccountTaxRate(payer, salesTax).toString(),
    payer: { name: `${payer.firstName} ${payer.lastName}`.trim(), email: payer.email, phone: payer.phone },
    earningsPlan: root.dealerMode === 'INTERNAL' ? await loadActiveEarningsPlan(db, root.dealerEarningsPlanId) : null,
  };
}

export async function descendantIds(db: Prisma.TransactionClient, actor: AuthUser): Promise<number[]> {
  if (actor.role?.name !== 'dealer') return [actor.id];
  const children = await db.user.findMany({ where: { parentDealerId: actor.id }, select: { id: true } });
  const ids = children.map(user => user.id);
  const grandchildren = ids.length ? await db.user.findMany({ where: { parentDealerId: { in: ids } }, select: { id: true } }) : [];
  return [actor.id, ...ids, ...grandchildren.map(user => user.id)];
}

export async function canAccessOwner(db: Prisma.TransactionClient, ownerId: number, actor: AuthUser): Promise<boolean> {
  if (isPrivileged(actor) || ownerId === actor.id) return true;
  if (actor.role?.name !== 'dealer') return false;
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { parentDealerId: true, parentDealer: { select: { parentDealerId: true } } } });
  return owner?.parentDealerId === actor.id || owner?.parentDealer?.parentDealerId === actor.id;
}

export async function assertNetworkAccess(db: Prisma.TransactionClient, estimate: { idUser: number } | null, actor: AuthUser) {
  if (!estimate || !await canAccessOwner(db, estimate.idUser, actor)) throw new NotFoundException('Estimate not found.');
}

export function billingAccountId(estimate: any): number {
  return networkSnapshot(estimate)?.billingAccountId ?? estimate.idUser;
}

// Conserva los importes del propietario y proyecta solamente el tramo que cobra Authentic.
export function billingEstimate<T extends Record<string, any>>(estimate: T): T {
  const snapshot = networkSnapshot(estimate);
  if (!snapshot) return estimate;
  const price = new Decimal(String(estimate.networkBillingPriceT ?? 0));
  const rate = new Decimal(snapshot.payerType === 'CUSTOMER' ? String(estimate.customerTaxRate ?? 0) : snapshot.billingTaxRate);
  const tax = price.mul(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { ...estimate, priceT: price.toFixed(2), taxRate: rate.toString(), taxAmount: tax.toFixed(2), totalPayable: price.add(tax).toFixed(2),
    ...(snapshot.payerType === 'CUSTOMER' ? { customerPriceT: price.toFixed(2), customerTaxRate: rate.toString(), customerTaxAmount: tax.toFixed(2), customerTotalPayable: price.add(tax).toFixed(2) } : {}),
    dealerModeSnapshot: snapshot.payerType === 'CUSTOMER' ? 'INTERNAL' : 'EXTERNAL' };
}

export function networkPieceTotals(pieces: Array<{ qty: number; networkPricing?: unknown }>) {
  const rows = pieces.filter(piece => piece.networkPricing != null);
  if (!rows.length) return {};
  if (rows.length !== pieces.length) throw new BadRequestException('Incomplete saved network prices. Recalculate the estimate.');
  let billing = new Decimal(0), root = new Decimal(0), subdealer = new Decimal(0);
  for (const piece of rows) {
    const pricing = piece.networkPricing as NetworkPiecePricing;
    if (pricing.version !== 1 || !pricing.prices?.[pricing.billingIndex]) throw new BadRequestException('Invalid saved network price.');
    billing = billing.add(new Decimal(pricing.prices[pricing.billingIndex]).mul(piece.qty));
    root = root.add(new Decimal(pricing.prices[0]).mul(piece.qty));
    subdealer = subdealer.add(new Decimal(pricing.prices[1]).mul(piece.qty));
  }
  return { networkBillingPriceT: new Prisma.Decimal(billing.toFixed(2)), networkRootPriceT: new Prisma.Decimal(root.toFixed(2)), networkSubdealerPriceT: new Prisma.Decimal(subdealer.toFixed(2)) };
}

export function applyNetworkPricing<T extends { qty: number; price: Decimal; regularPrice?: Decimal; dealerMarkupDecimal: Decimal; rate: Decimal }>(piece: T, snapshot?: NetworkSnapshot | null): T {
  if (!snapshot) return piece;
  const round = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const prices = [piece.price];
  const regular = [piece.regularPrice ?? piece.price];
  for (const node of snapshot.nodes.slice(1)) {
    const factor = new Decimal(1).add(node.markup);
    prices.push(round(prices.at(-1)!.mul(factor)));
    regular.push(round(regular.at(-1)!.mul(factor)));
  }
  const price = prices.at(-1)!;
  const customer = round(price.mul(new Decimal(1).add(piece.dealerMarkupDecimal)));
  return { ...piece, price, subtotal: price.mul(piece.qty), netProfit: price.sub(piece.rate),
    customerPrice: customer, customerSubtotal: customer.mul(piece.qty), netProfitD: customer.sub(price).mul(piece.qty),
    regularPrice: regular.at(-1)!, regularCustomerPrice: round(regular.at(-1)!.mul(new Decimal(1).add(piece.dealerMarkupDecimal))),
    networkPricing: { version: 1, billingIndex: snapshot.billingIndex, prices: [...prices, customer].map(value => value.toFixed(2)), regularPrices: [...regular, round(regular.at(-1)!.mul(new Decimal(1).add(piece.dealerMarkupDecimal)))].map(value => value.toFixed(2)) },
  };
}

export function networkPresentation(estimate: any) {
  const snapshot = networkSnapshot(estimate);
  if (!snapshot) return null;
  return { level: snapshot.nodes.at(-1)!.level, parentDealerId: snapshot.nodes.at(-2)!.id,
    rootDealerId: snapshot.nodes[0].id, rootMode: snapshot.rootMode,
    billingAccountId: snapshot.billingAccountId, payerType: snapshot.payerType, billingAccountName: snapshot.nodes[snapshot.billingIndex]?.username ?? 'Customer' };
}

// Los planes del subdealer reparten únicamente ganancias de material, nunca impuestos o servicios.
export function validateSubdealerPlan(mode: unknown, percent: unknown): NonNullable<NetworkSnapshot['subdealerPlan']> {
  if (mode !== 'AVAILABLE_PROFIT' && mode !== 'MARKUP') throw new BadRequestException('Select a subdealer earnings plan.');
  const value = mode === 'MARKUP' ? '100' : String(percent ?? '');
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(value) || new Decimal(value).gt(100))
    throw new BadRequestException('Earnings percentage must be between 0 and 100.');
  return { mode, percent: new Decimal(value).toString() };
}

export function networkMaterialProfit(estimate: any, viewerId?: number, materialDiscount: Decimal.Value = 0): string | null {
  const network = networkSnapshot(estimate);
  const index = network?.nodes.findIndex(node => node.id === viewerId) ?? -1;
  if (!network || index < 0 || network.nodes[index].mode !== 'EXTERNAL') return null;
  const prices = [estimate.networkRootPriceT, estimate.networkSubdealerPriceT];
  if (network.nodes.length === 3) prices.push(estimate.priceT);
  prices.push(estimate.customerPriceT);
  const discount = viewerId === network.billingAccountId ? materialDiscount : 0;
  return new Decimal(String(prices[index + 1] ?? 0)).minus(String(prices[index] ?? 0)).plus(discount).toFixed(2);
}
