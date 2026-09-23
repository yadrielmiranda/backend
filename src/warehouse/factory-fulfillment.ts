import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { assertBalances } from './warehouse-parts';

// La recogida interna no corresponde a una entrega directa al cliente en fábrica.
export function assertCompanyFactoryCollection(order: { fulfillmentMethod?: string }) {
  if (order.fulfillmentMethod === 'FACTORY_PICKUP')
    throw new BadRequestException(
      'This order is assigned to direct factory pickup. It cannot be collected for the warehouse.',
    );
}

export async function assertDirectFactoryPickup(
  tx: Prisma.TransactionClient,
  orderId: number,
  estimateId: number,
) {
  if (await tx.factoryPickupRunOrder.findFirst({ where: { orderId, activeSlot: 1 } }))
    throw new ConflictException('Finish the active factory pickup run before selecting or completing direct factory pickup.');
  const stocks = await tx.warehouseStock.findMany({
    where: { unit: { piece: { idEst: estimateId } } },
    orderBy: { lineNumber: 'asc' },
  });
  if (stocks.some(stock => stock.inTransit > 0 || stock.onHand > 0 || stock.released > 0))
    throw new ConflictException(
      'This order has parts already collected or released by the company. Resolve its warehouse movements before direct factory pickup.',
    );
  return stocks;
}

// Se ejecuta dentro de la misma transacción que completa la orden.
export async function recordDirectFactoryPickup(
  tx: Prisma.TransactionClient,
  orderId: number,
  estimateId: number,
  actorId: number,
) {
  const stocks = await assertDirectFactoryPickup(tx, orderId, estimateId);
  if (!stocks.length) return; // Órdenes anteriores sin unidades importadas.
  if (await tx.warehouseCount.findUnique({ where: { activeSlot: 1 } }))
    throw new ConflictException('Finish or cancel the physical count before completing factory pickup.');
  for (const stock of stocks) {
    assertBalances({ ...stock, released: stock.expectedParts });
    const quantity = stock.expectedParts!;
    const changed = await tx.warehouseStock.updateMany({
      where: { lineNumber: stock.lineNumber, version: stock.version },
      data: { released: quantity, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new ConflictException('Factory stock changed. Refresh the order before completing pickup.');
    const lineHash = createHash('sha256').update(stock.lineNumber).digest('hex');
    await tx.warehouseMovement.create({
      data: {
        lineNumber: stock.lineNumber,
        type: 'FACTORY_RELEASE',
        actorId,
        quantity,
        releasedDelta: quantity,
        transitAfter: 0,
        onHandAfter: 0,
        releasedAfter: quantity,
        expectedPartsBefore: quantity,
        expectedPartsAfter: quantity,
        stockVersionAfter: stock.version + 1,
        requestKey: `factory-pickup:${orderId}:${lineHash.slice(0, 32)}`,
        requestHash: createHash('sha256').update(JSON.stringify([orderId, stock.lineNumber, quantity])).digest('hex'),
        reason: 'Customer pickup completed directly at factory.',
      },
    });
  }
}
