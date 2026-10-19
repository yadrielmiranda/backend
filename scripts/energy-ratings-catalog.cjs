'use strict';

// Read only the catalog fields needed for exact energy-rating associations.
async function loadEnergyCatalog(db) {
  const [brands, products, systems, configs, crystals, systemCrystals, sysConfs, tints, coatings, privacies, brandTints, brandCoatings, brandPrivacies] = await Promise.all([
    db.brand.findMany({ select: { id: true, name: true, isActive: true } }),
    db.product.findMany({ select: { id: true, name: true, isActive: true, diagramFamily: true } }),
    db.system.findMany({ select: { id: true, name: true, idBrand: true, idProduct: true, isActive: true } }),
    db.config.findMany({ select: { id: true, conf: true, idProduct: true, isActive: true } }),
    db.crystal.findMany({ select: { id: true, glass: true, isActive: true } }),
    db.systemCrystal.findMany({ select: { idSystem: true, idCrystal: true } }),
    db.sysConf.findMany({ select: { idSystem: true, idConfig: true } }),
    db.tint.findMany({ select: { id: true, color: true, isActive: true, isGlobal: true } }),
    db.coating.findMany({ select: { id: true, name: true, isActive: true, isGlobal: true } }),
    db.privacy.findMany({ select: { id: true, name: true, isActive: true } }),
    db.brandTint.findMany({ select: { idBrand: true, idTint: true } }),
    db.brandCoating.findMany({ select: { idBrand: true, idCoating: true } }),
    db.brandPrivacy.findMany({ select: { idBrand: true, idPrivacy: true } }),
  ]);
  return { brands, products, systems, configs, crystals, systemCrystals, sysConfs, tints, coatings, privacies, brandTints, brandCoatings, brandPrivacies };
}

module.exports = { loadEnergyCatalog };
