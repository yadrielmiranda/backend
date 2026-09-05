import { DealerMode } from '@prisma/client';
import {
  calculateMaterialFinancials,
  resolveMaterialSaleSubtotal,
} from './order-material-financials';

describe('order material financials', () => {
  it('calculates the complete material profit without a company split', () => {
    const result = calculateMaterialFinancials({
      saleSubtotal: 1320,
      factoryRate: 1000,
    });

    expect(result.totalProfit.toFixed(2)).toBe('320.00');
  });

  it('uses the customer material subtotal for an internal dealer', () => {
    const saleSubtotal = resolveMaterialSaleSubtotal({
      dealerMode: DealerMode.INTERNAL,
      priceT: 1200,
      customerPriceT: 1380,
    });
    const result = calculateMaterialFinancials({
      saleSubtotal,
      factoryRate: 1000,
    });

    expect(saleSubtotal.toFixed(2)).toBe('1380.00');
    expect(result.totalProfit.toFixed(2)).toBe('380.00');
  });

  it.each([DealerMode.EXTERNAL, DealerMode.INTERNAL])(
    'keeps one material profit total for %s dealer sales',
    (mode) => {
      const saleSubtotal = mode === DealerMode.INTERNAL ? 1380 : 1320;
      const result = calculateMaterialFinancials({
        saleSubtotal,
        factoryRate: 1000,
      });

      expect(result.totalProfit.toFixed(2)).toBe(
        (saleSubtotal - 1000).toFixed(2),
      );
    },
  );
});
