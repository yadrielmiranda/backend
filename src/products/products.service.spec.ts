import { validate } from 'class-validator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

function fixture() {
  const current: any = { id: 3, name: 'Window', kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER', allowMuntin: true };
  const product = {
    aggregate: jest.fn(async () => ({ _max: { sortOrder: 4 } })),
    findUnique: jest.fn(async () => current),
    create: jest.fn(async ({ data }) => ({ id: 5, ...data })),
    update: jest.fn(async ({ data }) => Object.assign(current, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)))),
  };
  return { product, service: new ProductsService({ product } as any) };
}

describe('Product muntin permission', () => {
  it('defaults new products to enabled without tying permission to a diagram family', async () => {
    const f = fixture();
    expect(await f.service.createProduct({ name: 'Garage', diagramFamily: 'GARAGE_DOOR' })).toMatchObject({ allowMuntin: true });
    expect(await f.service.createProduct({ name: 'Window', allowMuntin: false })).toMatchObject({ allowMuntin: false });
  });

  it('allows disabling and re-enabling a product without editing existing pieces or catalog rules', async () => {
    const f = fixture();
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { allowMuntin: false } })).toMatchObject({ allowMuntin: false });
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { name: 'Renamed' } })).toMatchObject({ allowMuntin: false });
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { allowMuntin: null } })).toMatchObject({ allowMuntin: false });
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { allowMuntin: true } })).toMatchObject({ allowMuntin: true });
    expect(f.product.update).toHaveBeenCalledTimes(4);
  });

  it('keeps linear material disabled even when the caller asks to enable it', async () => {
    const f = fixture();
    expect(await f.service.createProduct({ name: 'Tube', kind: 'LINEAR_MATERIAL', allowMuntin: true })).toMatchObject({ allowMuntin: false });
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { kind: 'LINEAR_MATERIAL', pricingMode: 'LINEAR_INCH' } })).toMatchObject({ allowMuntin: false });
    expect(await f.service.updateProduct({ where: { id: 3 }, data: { allowMuntin: true } })).toMatchObject({ allowMuntin: false });
  });

  it.each([CreateProductDto, UpdateProductDto])('validates the toggle as a boolean for %p', async dtoClass => {
    for (const allowMuntin of [true, false])
      expect(await validate(Object.assign(new dtoClass(), { name: 'Window', allowMuntin }))).toEqual([]);
    for (const allowMuntin of ['false', 0, 1])
      expect(await validate(Object.assign(new dtoClass(), { name: 'Window', allowMuntin }))).not.toHaveLength(0);
  });
});
