import { DealerAffiliation, DealerMode } from '@prisma/client';
import {
  calculateMaterialFinancials,
  resolveImpactMarkupRate,
  resolveMaterialSaleSubtotal,
} from './order-material-financials';

describe('order material financial split', () => {
  it('splits an external Impact dealer using its stored 15% markup', () => {
    const result = calculateMaterialFinancials({
      saleSubtotal: 1320,
      factoryRate: 1000,
      dealerAffiliation: DealerAffiliation.IMPACT,
      impactMarkupRate: 0.15,
    });

    expect(result.factoryPriceWithMarkup.toFixed(2)).toBe('1150.00');
    expect(result.impactProfit.toFixed(2)).toBe('150.00');
    expect(result.authenticProfit.toFixed(2)).toBe('170.00');
    expect(result.totalProfit.toFixed(2)).toBe('320.00');
  });

  it('ignores the intermediate pricing markup for internal Impact', () => {
    const saleSubtotal = resolveMaterialSaleSubtotal({
      dealerMode: DealerMode.INTERNAL,
      priceT: 1200,
      customerPriceT: 1380,
    });
    const impactMarkupRate = resolveImpactMarkupRate({
      dealerMode: DealerMode.INTERNAL,
      dealerAffiliation: DealerAffiliation.IMPACT,
      ownerMarkupSnapshot: -0.1668954,
      priceT: 1200,
      customerPriceT: 1380,
    });
    const result = calculateMaterialFinancials({
      saleSubtotal,
      factoryRate: 1000,
      dealerAffiliation: DealerAffiliation.IMPACT,
      impactMarkupRate,
    });

    expect(impactMarkupRate.toFixed(4)).toBe('0.1500');
    expect(result.impactProfit.toFixed(2)).toBe('150.00');
    expect(result.authenticProfit.toFixed(2)).toBe('230.00');
  });

  it.each([DealerMode.EXTERNAL, DealerMode.INTERNAL])(
    'assigns all material profit to Authentic for %s Authentic sales',
    (mode) => {
      const saleSubtotal = mode === DealerMode.INTERNAL ? 1380 : 1320;
      const result = calculateMaterialFinancials({
        saleSubtotal,
        factoryRate: 1000,
        dealerAffiliation: DealerAffiliation.AUTHENTIC,
        impactMarkupRate: 0.15,
      });

      expect(result.impactProfit.toFixed(2)).toBe('0.00');
      expect(result.authenticProfit.toFixed(2)).toBe(
        (saleSubtotal - 1000).toFixed(2),
      );
    },
  );
});
