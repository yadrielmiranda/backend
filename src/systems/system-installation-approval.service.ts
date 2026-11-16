import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@/prisma/prisma.service';
import {
  parseInstallationApprovalCatalog, resolveInstallationApproval, resolveProductApproval,
  type InstallationApprovalResult, type InstallationApprovalRecord, type ProductApprovalResult,
} from './installation-approval';

export const INSTALLATION_APPROVAL_CATALOG_URL = 'https://authentic-aprobaciones-eco-novo.anthony08540.chatgpt.site/downloads/catalogo.json';
export const INSTALLATION_APPROVAL_MAX_BYTES = 1024 * 1024;
export const PRODUCT_APPROVAL_MAX_SYSTEMS = 100;
const unavailable = 'Installation documents are temporarily unavailable. Please try again.';
const systemIdentitySelect = {
  name: true,
  brandProduct: { select: { brand: { select: { name: true } }, product: { select: { name: true } } } },
} as const;

export type SystemProductApproval = {
  systemId: number; systemName: string; brandName: string; productName: string;
} & ProductApprovalResult;

export function parseApprovalSystemIds(value: unknown): number[] {
  if (typeof value !== 'string' || value.length > 2048 || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(value))
    throw new BadRequestException('Enter 1 to 100 valid system IDs separated by commas.');
  const ids = [...new Set(value.split(',').map(Number))];
  if (ids.length > PRODUCT_APPROVAL_MAX_SYSTEMS || ids.some(id => !Number.isSafeInteger(id) || id > 2147483647))
    throw new BadRequestException('Enter 1 to 100 valid system IDs separated by commas.');
  return ids;
}

@Injectable()
export class SystemInstallationApprovalService {
  constructor(private readonly prisma: PrismaService, private readonly http: HttpService) {}

  async find(systemId: number): Promise<InstallationApprovalResult> {
    if (!Number.isSafeInteger(systemId) || systemId < 1 || systemId > 2147483647) throw new BadRequestException('Enter a valid system ID.');
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: systemIdentitySelect,
    });
    if (!system) throw new NotFoundException('System not found.');
    const approvals = await this.loadCatalog();
    return resolveInstallationApproval({
      name: system.name,
      brandName: system.brandProduct.brand.name,
      productName: system.brandProduct.product.name,
    }, approvals);
  }

  async findBatch(idsQuery: unknown): Promise<{ systems: SystemProductApproval[] }> {
    const ids = parseApprovalSystemIds(idsQuery);
    const systems = await this.prisma.system.findMany({
      where: { id: { in: ids } }, select: { id: true, ...systemIdentitySelect },
    });
    const byId = new Map(systems.map(system => [system.id, system]));
    if (ids.some(id => !byId.has(id))) throw new NotFoundException('System not found.');
    const approvals = await this.loadCatalog();
    const now = new Date();
    return { systems: ids.map(id => {
      const system = byId.get(id)!;
      const identity = {
        name: system.name,
        brandName: system.brandProduct.brand.name,
        productName: system.brandProduct.product.name,
      };
      return {
        systemId: id, systemName: identity.name, brandName: identity.brandName, productName: identity.productName,
        ...resolveProductApproval(identity, approvals, now),
      };
    }) };
  }

  private async loadCatalog(): Promise<InstallationApprovalRecord[]> {
    // No catalog is saved or cached. A batch shares exactly one fresh bounded
    // GET within that request, and subsequent requests fetch it again.
    try {
      const response = await firstValueFrom(this.http.get<string>(INSTALLATION_APPROVAL_CATALOG_URL, {
        timeout: 8000,
        responseType: 'text',
        maxContentLength: INSTALLATION_APPROVAL_MAX_BYTES,
        maxBodyLength: INSTALLATION_APPROVAL_MAX_BYTES,
        maxRedirects: 0,
        transformResponse: [value => value],
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
      }));
      const contentType = String(response.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || !/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(contentType) ||
        typeof response.data !== 'string' || Buffer.byteLength(response.data, 'utf8') > INSTALLATION_APPROVAL_MAX_BYTES) {
        throw new Error('Invalid catalog response.');
      }
      return parseInstallationApprovalCatalog(JSON.parse(response.data));
    } catch {
      throw new ServiceUnavailableException(unavailable);
    }
  }
}
