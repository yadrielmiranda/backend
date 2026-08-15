export class EstimateAuditSnapshotBuilder {
  static build(est: any) {
    // comentario en espanol: snapshot estable para auditoria, no guardamos el objeto completo
    return {
      id: est.id,
      number: est.number,
      name: est.name,
      idUser: est.idUser,
      expiresAt: est.expiresAt ?? null,
      statusId: est.statusId,
      statusName: est.status?.name ?? null,
      orderId: est.order?.id ?? null,

      units: est.units,

      // totals
      rateT: est.rateT ?? null,
      priceT: est.priceT ?? null,
      netProfit: est.netProfit ?? null,
      taxRate: est.taxRate ?? null,
      taxAmount: est.taxAmount ?? null,
      totalPayable: est.totalPayable ?? null,

      customerPriceT: est.customerPriceT ?? null,
      customerTaxRate: est.customerTaxRate ?? null,
      customerTaxAmount: est.customerTaxAmount ?? null,
      customerTotalPayable: est.customerTotalPayable ?? null,

      netProfitD: est.netProfitD ?? null,

      // customer
      customerFirstName: est.customerFirstName ?? null,
      customerLastName: est.customerLastName ?? null,
      customerEmail: est.customerEmail ?? null,
      customerPhone: est.customerPhone ?? null,
      customerStreet: est.customerStreet ?? null,
      customerCity: est.customerCity ?? null,
      customerState: est.customerState ?? null,
      customerPostalCode: est.customerPostalCode ?? null,

      // pieces summary
      pieces: Array.isArray(est.pieces)
        ? est.pieces.map((p: any) => ({
          id: p.id ?? null,
          mark: p.mark ?? null,
          qty: p.qty ?? null,

          // dimensions
          width: p.width ?? null,
          height: p.height ?? null,
          heightLeft: p.heightLeft ?? null,
          heightRight: p.heightRight ?? null,
          legHeight: p.legHeight ?? null,
          sashHeight: p.sashHeight ?? null,
          windowHeight: p.windowHeight ?? null,

          doorWidth: p.doorWidth ?? null,
          doorHeight: p.doorHeight ?? null,
          leftSideliteWidth: p.leftSideliteWidth ?? null,
          rightSideliteWidth: p.rightSideliteWidth ?? null,

          leftPanels: p.leftPanels ?? null,
          rightPanels: p.rightPanels ?? null,
          panelCount: p.panelCount ?? null,
          horizontalHeights: p.horizontalHeights ?? null,

          // relation ids
          idProd: p.idProd ?? null,
          idBrand: p.idBrand ?? null,
          idSyst: p.idSyst ?? null,
          idConf: p.idConf ?? null,
          idFC: p.idFC ?? null,
          idCryst: p.idCryst ?? null,
          idTint: p.idTint ?? null,
          idCoat: p.idCoat ?? null,
          idPrivacy: p.idPrivacy ?? null,
          privacyName: p.privacyOption?.name ?? null,

          // money
          rate: p.rate ?? null,
          price: p.price ?? null,
          subtotal: p.subtotal ?? null,
          netProfit: p.netProfit ?? null,

          dealerMarkup: p.dealerMarkup ?? null,
          netProfitD: p.netProfitD ?? null,

          customerPrice: p.customerPrice ?? null,
          customerSubtotal: p.customerSubtotal ?? null,

          dpPosPsf: p.dpPosPsf ?? null,
          dpNegPsf: p.dpNegPsf ?? null,

          // flags
          screen: p.screen ?? null,

          muntin: p.pieceMuntin
            ? {
              id: p.pieceMuntin.id ?? null,
              patternId: p.pieceMuntin.patternId ?? null,
              patternName: p.pieceMuntin.pattern?.name ?? null,
              typeId: p.pieceMuntin.typeId ?? null,
              typeName: p.pieceMuntin.type?.name ?? null,
              totalLites: p.pieceMuntin.totalLites ?? null,
              panels: Array.isArray(p.pieceMuntin.panels)
                ? p.pieceMuntin.panels.map((mp: any) => ({
                  id: mp.id ?? null,
                  panelIndex: mp.panelIndex ?? null,
                  panelCode: mp.panelCode ?? null,
                  panelLabel: mp.panelLabel ?? null,
                  horizontalLites: mp.horizontalLites ?? null,
                  verticalLites: mp.verticalLites ?? null,
                }))
                : [],
            }
            : null,
        }))
        : [],

      piecesCount: Array.isArray(est.pieces) ? est.pieces.length : 0,
    };
  }
}
