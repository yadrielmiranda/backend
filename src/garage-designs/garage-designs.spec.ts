import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { SystemDesignsController } from '@/systems/system-designs.controller';
import { GarageDesignsController } from './garage-designs.controller';
import { GarageDesignsService } from './garage-designs.service';
import { CreateDesignColorDto, CreateDesignPatternDto } from './dto/design-catalog.dto';
import { isSafeDesignPreviewReference } from './design-preview-reference';

describe('Garage design catalog inputs and permissions', () => {
  it.each(['https://example.com/design.png', 'http://example.com/design.png', '/product-visuals/design.png'])('accepts safe preview %s', reference => {
    expect(isSafeDesignPreviewReference(reference)).toBe(true);
  });
  it.each(['//evil.test/image', '/\\evil.test/image', 'javascript:alert(1)', 'data:image/svg+xml,test', 'https:example.com/image',
    'https://user:password@example.com/image', 'file:///image.png', '/image\n.png', '', null])('rejects unsafe preview %s', reference => {
    expect(isSafeDesignPreviewReference(reference)).toBe(false);
  });
  it('normalizes pattern names and optional previews, and rejects unsafe URLs through the DTO', async () => {
    const dto = plainToInstance(CreateDesignPatternDto, { name: ' Left / Right ', imageUrl: ' ' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.name).toBe('Left / Right');
    expect(dto.imageUrl).toBeNull();
    expect(await validate(plainToInstance(CreateDesignPatternDto, { ...dto, imageUrl: '//evil.test' }))).not.toHaveLength(0);
  });
  it('accepts a design using only its name and optional image', async () => {
    const dto = plainToInstance(CreateDesignPatternDto, { name: ' SF ', imageUrl: '/images/sf.png' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.name).toBe('SF');
    expect(dto).toEqual({ name: 'SF', imageUrl: '/images/sf.png' });
  });
  it('strips removed catalog fields under the application validation policy', async () => {
    const options = { whitelist: true, forbidNonWhitelisted: false };
    const pattern = plainToInstance(CreateDesignPatternDto, { name: 'SF', code: 'SF' });
    const color = plainToInstance(CreateDesignColorDto, { name: 'Black', hexCode: '#000000', idFrameColor: 6, textureUrl: '/old-texture.png' });
    expect(await validate(pattern, options)).toEqual([]);
    expect(await validate(color, options)).toEqual([]);
    expect(pattern).toEqual({ name: 'SF' });
    expect(color).toEqual({ name: 'Black', hexCode: '#000000', idFrameColor: 6 });
  });

  it.each([
    [GarageDesignsController, 'createPattern'], [GarageDesignsController, 'updatePattern'],
    [GarageDesignsController, 'deletePattern'],
    [GarageDesignsController, 'createColor'], [GarageDesignsController, 'updateColor'],
    [SystemDesignsController, 'update'],
  ] as const)('restricts %p.%s to admin', (controller, method) => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: string) => ({ getHandler: () => controller.prototype[method], getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: role } } }) }) }) as any;
    expect(guard.canActivate(context('admin'))).toBe(true);
    for (const role of ['dealer', 'client', 'technician']) expect(guard.canActivate(context(role))).toBe(false);
  });

  it('allows authenticated commercial roles to read the catalog and series options', () => {
    const guard = new RolesGuard(new Reflector());
    for (const [controller, method] of [[GarageDesignsController, 'patterns'], [GarageDesignsController, 'colors'], [SystemDesignsController, 'manage']] as const) {
      expect(guard.canActivate({ getHandler: () => controller.prototype[method], getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: 'dealer' } } }) }) } as any)).toBe(true);
    }
  });
});

describe('Garage design deletion', () => {
  function fixture() {
    const tx = {
      designPattern: {
        findUnique: jest.fn(async () => ({ id: 7 }) as any),
        delete: jest.fn(async () => ({ id: 7 })),
      },
      systemDesignOption: { findFirst: jest.fn(async () => null as any) },
      system: { findFirst: jest.fn(async () => null as any) },
      piece: { findFirst: jest.fn(async () => null as any) },
    };
    const prisma = { $transaction: jest.fn(async (action: any, _options?: any) => action(tx)) };
    return { tx, prisma, service: new GarageDesignsService(prisma as any) };
  }

  it('deletes an unused design and returns its id inside a serializable transaction', async () => {
    const f = fixture();
    await expect(f.service.deletePattern(7)).resolves.toEqual({ id: 7 });
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(f.tx.designPattern.delete).toHaveBeenCalledWith({ where: { id: 7 }, select: { id: true } });
  });

  it('blocks a design included in any series combination', async () => {
    const f = fixture();
    f.tx.systemDesignOption.findFirst.mockResolvedValue({ idSystem: 3 });
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('all series') });
    expect(f.tx.systemDesignOption.findFirst).toHaveBeenCalledWith({ where: { idDesign: 7 }, select: { idSystem: true } });
    expect(f.tx.designPattern.delete).not.toHaveBeenCalled();
  });

  it('blocks any series default even if the series or its Design option is disabled', async () => {
    const f = fixture();
    f.tx.system.findFirst.mockResolvedValue({ id: 3 });
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('defaults') });
    expect(f.tx.system.findFirst).toHaveBeenCalledWith({ where: { defaultDesignId: 7 }, select: { id: true } });
    expect(f.tx.designPattern.delete).not.toHaveBeenCalled();
  });

  it('preserves designs used by saved pieces and recommends deactivation', async () => {
    const f = fixture();
    f.tx.piece.findFirst.mockResolvedValue({ id: 25 });
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Deactivate it instead') });
    expect(f.tx.piece.findFirst).toHaveBeenCalledWith({ where: { idDesign: 7 }, select: { id: true } });
    expect(f.tx.designPattern.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing design without attempting deletion', async () => {
    const f = fixture();
    f.tx.designPattern.findUnique.mockResolvedValue(null);
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 404 });
    expect(f.tx.designPattern.delete).not.toHaveBeenCalled();
  });

  it('returns a useful conflict if a new reference wins the race before deletion', async () => {
    const f = fixture();
    f.tx.designPattern.delete.mockRejectedValue({ code: 'P2003' });
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('deactivate it if saved pieces use it') });
  });

  it('returns 404 if the design disappears before deletion', async () => {
    const f = fixture();
    f.tx.designPattern.delete.mockRejectedValue({ code: 'P2025' });
    await expect(f.service.deletePattern(7)).rejects.toMatchObject({ status: 404 });
  });
});

describe('Garage design catalog lifecycle', () => {
  function fixture() {
    const tx = { system: { findFirst: jest.fn(async () => null as any) },
      frameColor: { findUnique: jest.fn(async () => ({ id: 6, isActive: true }) as any) },
      designPattern: { update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })), create: jest.fn(async ({ data }: any) => data) },
      designColor: { update: jest.fn(async ({ data }: any) => ({ id: 2, ...data })), create: jest.fn(async ({ data }: any) => data) } };
    const prisma = { ...tx, $transaction: jest.fn(async (action: any) => action(tx)) };
    return { tx, service: new GarageDesignsService(prisma as any) };
  }
  it('does not deactivate a default used by an enabled series', async () => {
    const f = fixture();
    f.tx.system.findFirst.mockResolvedValue({ id: 10 });
    await expect(f.service.updatePattern(1, { isActive: false })).rejects.toThrow('default for an enabled series');
    await expect(f.service.updateColor(2, { isActive: false })).rejects.toThrow('default for an enabled series');
    expect(f.tx.designPattern.update).not.toHaveBeenCalled();
    expect(f.tx.designColor.update).not.toHaveBeenCalled();
  });
  it('deactivates through updates without deleting catalog references', async () => {
    const f = fixture();
    expect(await f.service.updatePattern(1, { isActive: false })).toEqual({ id: 1, isActive: false });
    expect(await f.service.updateColor(2, { isActive: false })).toEqual({ id: 2, isActive: false });
  });
  it('normalizes catalog writes and rejects invalid preview references before persistence', async () => {
    const f = fixture();
    expect(await f.service.createPattern({ name: ' Standard ', imageUrl: '/images/sf.png' })).toEqual({ name: 'Standard', imageUrl: '/images/sf.png' });
    await expect(f.service.updatePattern(1, { imageUrl: 'javascript:alert(1)' })).rejects.toThrow('HTTP/HTTPS');
    expect(f.tx.designPattern.update).not.toHaveBeenCalled();
  });
  it('creates designs from a name and keeps existing references unchanged when renaming', async () => {
    const f = fixture();
    const first = await f.service.createPattern({ name: ' SF ', imageUrl: '/images/sf.png' });
    const second = await f.service.createPattern({ name: 'GT' });
    expect(first).toEqual({ name: 'SF', imageUrl: '/images/sf.png' });
    expect(second).toEqual({ name: 'GT' });
    await f.service.updatePattern(1, { name: 'SL36' });
    expect(f.tx.designPattern.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { name: 'SL36' } });
  });
  it('stores a color as name and hex color without an image or texture', async () => {
    const f = fixture();
    expect(await f.service.createColor({ name: ' Black ', hexCode: '#aabbcc', idFrameColor: 6 })).toEqual({ name: 'Black', hexCode: '#AABBCC', idFrameColor: 6 });
  });
  it.each([undefined, null, 0, -1, 1.5, '6'])('requires an explicit frame-color link (%s)', async value => {
    const f = fixture();
    const input = { name: 'Oak', hexCode: '#AABBCC', idFrameColor: value } as any;
    expect(await validate(plainToInstance(CreateDesignColorDto, input))).not.toHaveLength(0);
    await expect(f.service.createColor(input)).rejects.toThrow('existing frame color');
    expect(f.tx.designColor.create).not.toHaveBeenCalled();
  });
  it.each([null, { id: 6, isActive: false }])('rejects missing or inactive frame colors', async frame => {
    const f = fixture();
    f.tx.frameColor.findUnique.mockResolvedValue(frame);
    await expect(f.service.createColor({ name: 'Oak', hexCode: '#AABBCC', idFrameColor: 6 })).rejects.toThrow('active frame color');
    await expect(f.service.updateColor(2, { idFrameColor: 6 })).rejects.toThrow('active frame color');
    expect(f.tx.designColor.create).not.toHaveBeenCalled();
    expect(f.tx.designColor.update).not.toHaveBeenCalled();
  });
  it('persists a selected link by id and keeps ordinary activation changes independent', async () => {
    const f = fixture();
    expect(await f.service.updateColor(2, { idFrameColor: 6 })).toMatchObject({ idFrameColor: 6 });
    expect(f.tx.frameColor.findUnique).toHaveBeenCalledWith({ where: { id: 6 }, select: { id: true, isActive: true } });
    f.tx.frameColor.findUnique.mockClear();
    expect(await f.service.updateColor(2, { isActive: true })).toEqual({ id: 2, isActive: true });
    expect(f.tx.frameColor.findUnique).not.toHaveBeenCalled();
    await expect(f.service.updateColor(2, { idFrameColor: null } as any)).rejects.toThrow('existing frame color');
  });
});
