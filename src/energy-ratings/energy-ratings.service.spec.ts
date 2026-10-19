import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import {
  CreateEnergyRatingDto,
  FindEnergyRatingsDto,
} from './dto/energy-rating.dto';
import { EnergyRatingsController } from './energy-ratings.controller';
import {
  EnergyRatingsService,
  validateEnergyValues,
} from './energy-ratings.service';

describe('energy catalog validation', () => {
  it('requires all three numeric values and rejects invalid ranges', () => {
    expect(() => validateEnergyValues({ uFactor: 1 })).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateEnergyValues({ uFactor: 0, shgc: 0.3, vlt: 0.4 }),
    ).toThrow();
    expect(() =>
      validateEnergyValues({ uFactor: 1, shgc: 1.1, vlt: 0.4 }),
    ).toThrow();
    expect(() =>
      validateEnergyValues({ uFactor: 1, shgc: 0.3, vlt: -0.1 }),
    ).toThrow();
    expect(() =>
      validateEnergyValues({ uFactor: true, shgc: 0.3, vlt: 0.4 }),
    ).toThrow();
    expect(() =>
      validateEnergyValues({ uFactor: '', shgc: 0.3, vlt: 0.4 }),
    ).toThrow();
    expect(() =>
      validateEnergyValues({ uFactor: 0.0000001, shgc: 0.3, vlt: 0.4 }),
    ).toThrow();
    expect(validateEnergyValues({})).toEqual({
      uFactor: null,
      shgc: null,
      vlt: null,
    });
    expect(
      validateEnergyValues({
        uFactor: '1.062',
        shgc: 0,
        vlt: 1,
      }).shgc.toString(),
    ).toBe('0');
  });

  it('parses false list filters correctly with global implicit conversion enabled', async () => {
    const query = plainToInstance(
      FindEnergyRatingsDto,
      { isActive: 'false' },
      { enableImplicitConversion: true },
    );
    expect(query.isActive).toBe(false);
    expect(await validate(query)).toEqual([]);
  });

  const dto: CreateEnergyRatingDto = {
    idSystem: 10,
    idCrystal: 5,
    idTint: 1,
    idCoating: 2,
    idPrivacy: 1,
    appliesToAllConfigs: true,
    uFactor: '1.062',
    shgc: '0.278',
    vlt: '0.501',
  };
  const setup = () => {
    const tx = {
      systemCrystal: {
        findUnique: jest.fn().mockResolvedValue({
          system: {
            idBrand: 3,
            brandProduct: { product: { kind: 'GLAZED_UNIT' } },
          },
        }),
      },
      brandTint: { findUnique: jest.fn().mockResolvedValue({}) },
      brandCoating: { findUnique: jest.fn().mockResolvedValue({}) },
      brandPrivacy: { findUnique: jest.fn().mockResolvedValue({}) },
      sysConf: { findUnique: jest.fn().mockResolvedValue({}) },
      energyRating: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    const db = { $transaction: jest.fn((callback) => callback(tx)) };
    return { tx, service: new EnergyRatingsService(db as any) };
  };

  it('discards retired source fields and units from catalog requests', async () => {
    const input = plainToInstance(CreateEnergyRatingDto, {
      ...dto,
      sourceFile: 'old.xlsx', sourceSheet: 'Sheet1', sourceRow: 93,
      sourceVersion: '0.9', sourceGlassId: 'GL-1',
      composition: 'Old description', notes: 'Old source metadata',
      units: 'U_FACTOR_IP',
    });
    expect(await validate(input, { whitelist: true })).toEqual([]);
    expect(input).toEqual(dto);
    const { tx, service } = setup();
    tx.energyRating.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.create(input)).rejects.toThrow(ConflictException);
    const data = tx.energyRating.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      'idSystem', 'idCrystal', 'idTint', 'idCoating', 'idPrivacy', 'idConfig',
      'appliesToAllConfigs', 'uFactor', 'shgc', 'vlt', 'isActive', 'activeKey',
    ].sort());
  });

  it('rejects unsupported glass and unassociated brand privacy', async () => {
    const { tx, service } = setup();
    tx.systemCrystal.findUnique.mockResolvedValueOnce(null);
    await expect(service.create(dto)).rejects.toThrow('glass must belong');
    tx.brandPrivacy.findUnique.mockResolvedValueOnce(null);
    await expect(service.create(dto)).rejects.toThrow('must be associated');
    expect(tx.energyRating.create).not.toHaveBeenCalled();
  });

  it('requires explicit general scope or a valid series/configuration association', async () => {
    const { tx, service } = setup();
    await expect(
      service.create({ ...dto, appliesToAllConfigs: false }),
    ).rejects.toThrow('explicitly confirm');
    tx.sysConf.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.create({ ...dto, idConfig: 8, appliesToAllConfigs: false }),
    ).rejects.toThrow('configuration must belong');
    expect(tx.energyRating.create).not.toHaveBeenCalled();
  });

  it('turns concurrent duplicate creation into a clear conflict', async () => {
    const { tx, service } = setup();
    tx.energyRating.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.create(dto)).rejects.toThrow(ConflictException);
    expect(tx.energyRating.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeKey: '10:5:1:2:1:*',
        }),
      }),
    );
  });

  it('can deactivate a saved rating after a brand association was removed', async () => {
    const { tx, service } = setup();
    const before = {
      id: 99,
      ...dto,
      idConfig: null,
      isActive: true,
      activeKey: '10:5:1:2:1:*',
    };
    tx.energyRating.findUnique.mockResolvedValue(before);
    tx.brandPrivacy.findUnique.mockResolvedValue(null);
    tx.energyRating.update.mockResolvedValue({
      ...before,
      isActive: false,
      activeKey: null,
      systemCrystal: {
        crystal: { id: 5, glass: 'Glass' },
        system: {
          id: 10,
          name: '100',
          idBrand: 3,
          idProduct: 2,
          brandProduct: {
            brand: { name: 'Brand' },
            product: { name: 'Product' },
          },
        },
      },
      config: null,
      tint: { id: 1, color: 'Clear' },
      coating: { id: 2, name: 'LowE SB70' },
      privacy: { id: 1, name: 'White' },
    });
    await expect(
      service.update(99, { isActive: false, idConfig: undefined }),
    ).resolves.toMatchObject({ isActive: false });
    expect(tx.energyRating.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 99 },
        data: { isActive: false, activeKey: null },
      }),
    );
    expect(tx.systemCrystal.findUnique).not.toHaveBeenCalled();
    expect(tx.brandPrivacy.findUnique).not.toHaveBeenCalled();
  });

  it('still validates a retargeted selection even when the patch also deactivates it', async () => {
    const { tx, service } = setup();
    tx.energyRating.findUnique.mockResolvedValue({
      id: 99,
      ...dto,
      idConfig: null,
    });
    tx.brandPrivacy.findUnique.mockResolvedValue(null);
    await expect(
      service.update(99, { isActive: false, idPrivacy: 9 }),
    ).rejects.toThrow('must be associated');
    expect(tx.brandPrivacy.findUnique).toHaveBeenCalledWith({
      where: { idBrand_idPrivacy: { idBrand: 3, idPrivacy: 9 } },
    });
    expect(tx.energyRating.update).not.toHaveBeenCalled();
  });

  it('cannot deactivate a nonexistent rating', async () => {
    const { tx, service } = setup();
    tx.energyRating.findUnique.mockResolvedValue(null);
    await expect(service.update(99, { isActive: false })).rejects.toThrow(
      'Energy rating not found',
    );
    expect(tx.energyRating.update).not.toHaveBeenCalled();
  });
});

describe('energy catalog authorization', () => {
  const guard = new RolesGuard(new Reflector());
  function allowed(method: keyof EnergyRatingsController, role: string) {
    return guard.canActivate({
      getHandler: () => EnergyRatingsController.prototype[method],
      getClass: () => EnergyRatingsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: { name: role } } }),
      }),
    } as any);
  }
  it('allows staff reads and administrator-only changes', () => {
    expect(allowed('findAll', 'admin')).toBe(true);
    expect(allowed('catalogOptions', 'operator')).toBe(true);
    expect(allowed('findAll', 'dealer')).toBe(false);
    expect(allowed('findAll', 'technician')).toBe(false);
    expect(allowed('create', 'operator')).toBe(false);
    expect(allowed('update', 'dealer')).toBe(false);
    expect(allowed('create', 'admin')).toBe(true);
  });
});
