import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  INSTALLATION_APPROVAL_CATALOG_URL, INSTALLATION_APPROVAL_MAX_BYTES, SystemInstallationApprovalService,
  parseApprovalSystemIds,
} from './system-installation-approval.service';
import { INSTALLATION_APPROVAL_CATALOG_SCHEMA } from './installation-approval';

const catalog = { schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: [{
  brand: 'ECO Window Systems', series: '700', product: 'Sliding Glass Door', variant: 'LMI',
  approvalId: 'APPROVAL-A', status: 'Approved', archived: false, eligibleForCurrentDocumentList: true,
  installationUrl: 'https://floridabuilding.org/upload/PR_Instl_Docs/test.pdf',
  evaluationUrl: 'https://floridabuilding.org/upload/PR_Tech_Docs/test.pdf',
  officialUrl: 'https://floridabuilding.org/pr/pr_app_dtl.aspx?param=TEST',
}] };
function fixture() {
  const systems = [{ id: 36,
    name: 'Serie 700', brandProduct: { brand: { name: 'Eco Windows Systems' }, product: { name: 'Sliding Glass Door' } },
  }, { id: 22,
    name: 'Mullion', brandProduct: { brand: { name: 'Eco Windows Systems' }, product: { name: 'Mullion' } },
  }];
  const prisma = { system: { findUnique: jest.fn().mockResolvedValue({
    name: 'Serie 700', brandProduct: { brand: { name: 'Eco Windows Systems' }, product: { name: 'Sliding Glass Door' } },
  }), findMany: jest.fn().mockResolvedValue(systems) } };
  const response = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, data: JSON.stringify(catalog) };
  const http = { get: jest.fn().mockReturnValue(of(response)) };
  return { prisma, http, response, service: new SystemInstallationApprovalService(prisma as any, http as any) };
}

describe('SystemInstallationApprovalService', () => {
  it('loads only the selected system identity and performs a bounded, uncached GET each time', async () => {
    const f = fixture();
    await expect(f.service.find(36)).resolves.toEqual({
      status: 'available', url: catalog.approvals[0].installationUrl, approvalId: 'APPROVAL-A', variant: 'LMI',
    });
    expect(f.prisma.system.findUnique).toHaveBeenCalledWith({
      where: { id: 36 }, select: { name: true, brandProduct: { select: {
        brand: { select: { name: true } }, product: { select: { name: true } },
      } } },
    });
    expect(f.http.get).toHaveBeenCalledWith(INSTALLATION_APPROVAL_CATALOG_URL, expect.objectContaining({
      timeout: 8000, maxContentLength: INSTALLATION_APPROVAL_MAX_BYTES, maxBodyLength: INSTALLATION_APPROVAL_MAX_BYTES,
      maxRedirects: 0, responseType: 'text', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
    }));
    f.http.get.mockReturnValueOnce(of({ ...f.response, data: JSON.stringify({ ...catalog, approvals: [] }) }));
    await expect(f.service.find(36)).resolves.toEqual({ status: 'not_found' });
    expect(f.http.get).toHaveBeenCalledTimes(2);
    expect(f.prisma.system.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not call upstream for a nonexistent or invalid system', async () => {
    const f = fixture();
    for (const id of [0, -1, 1.5, NaN, Infinity, 2147483648]) await expect(f.service.find(id)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.system.findUnique).not.toHaveBeenCalled();
    f.prisma.system.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.find(36)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.http.get).not.toHaveBeenCalled();
  });

  it.each([
    { status: 301 }, { status: 503 }, { headers: { 'content-type': 'text/html' } },
    { data: '<html>unavailable</html>' }, { data: '{}' }, { data: '{' },
    { data: JSON.stringify({ ...catalog, schema: 'unsupported' }) },
    { data: JSON.stringify({ ...catalog, approvals: [{ ...catalog.approvals[0], archived: 'false' }] }) },
    { data: 'x'.repeat(INSTALLATION_APPROVAL_MAX_BYTES + 1) },
  ])('returns unavailable, never not_found, for an invalid upstream response %#', async overrides => {
    const f = fixture();
    f.http.get.mockReturnValueOnce(of({ ...f.response, ...overrides }));
    const error = await f.service.find(36).catch(value => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('Installation documents are temporarily unavailable. Please try again.');
  });
  it('does not reuse a successful response after a later upstream timeout', async () => {
    const f = fixture();
    await expect(f.service.find(36)).resolves.toHaveProperty('status', 'available');
    f.http.get.mockReturnValueOnce(throwError(() => new Error('timeout with private upstream diagnostics')));
    const error = await f.service.find(36).catch(value => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error.getResponse())).not.toContain('private');
    expect(f.http.get).toHaveBeenCalledTimes(2);
  });
});

describe('Batched system product approvals', () => {
  it('reads identities once and returns real names in requested deduplicated order using one fresh catalog GET', async () => {
    const f = fixture();
    const result = await f.service.findBatch('22,36,22');
    expect(result).toEqual({ systems: [{
      systemId: 22, systemName: 'Mullion', brandName: 'Eco Windows Systems', productName: 'Mullion', status: 'not_found',
    }, {
      systemId: 36, systemName: 'Serie 700', brandName: 'Eco Windows Systems', productName: 'Sliding Glass Door',
      status: 'available', approvalId: 'APPROVAL-A', variant: 'LMI',
      installationUrl: catalog.approvals[0].installationUrl,
      evaluationUrl: catalog.approvals[0].evaluationUrl,
      officialUrl: catalog.approvals[0].officialUrl,
    }] });
    expect(f.prisma.system.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.system.findMany).toHaveBeenCalledWith({ where: { id: { in: [22, 36] } }, select: {
      id: true, name: true, brandProduct: { select: { brand: { select: { name: true } }, product: { select: { name: true } } } },
    } });
    expect(f.prisma.system.findUnique).not.toHaveBeenCalled();
    expect(f.http.get).toHaveBeenCalledTimes(1);
    f.http.get.mockReturnValueOnce(of({ ...f.response, data: JSON.stringify({ ...catalog, approvals: [] }) }));
    await expect(f.service.findBatch('36')).resolves.toEqual({ systems: [{
      systemId: 36, systemName: 'Serie 700', brandName: 'Eco Windows Systems', productName: 'Sliding Glass Door', status: 'not_found',
    }] });
    expect(f.http.get).toHaveBeenCalledTimes(2);
    expect(f.prisma.system.findMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined, null, [], ['36'], {}, 36, '', ' ', '0', '-1', '1.2', '1e2', '01', '1,', ',1', '1,,2',
    '1, 2', '1;2', '2147483648', '9007199254740993', '1'.repeat(2049),
    Array.from({ length: 101 }, (_, index) => index + 1).join(','),
  ])('rejects malformed or excessive batch IDs before any database or upstream lookup %#', async value => {
    const f = fixture();
    await expect(f.service.findBatch(value)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.system.findMany).not.toHaveBeenCalled();
    expect(f.http.get).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 unique IDs and the Prisma integer limit, preserving first occurrence order', () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(parseApprovalSystemIds(ids.join(','))).toEqual(ids);
    expect(parseApprovalSystemIds('2147483647,36,2147483647')).toEqual([2147483647, 36]);
  });

  it('rejects the whole batch if any requested system is missing, before reading the catalog', async () => {
    const f = fixture();
    await expect(f.service.findBatch('36,999')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.http.get).not.toHaveBeenCalled();
  });

  it('returns ambiguous without any URL when evaluations conflict despite one shared installation PDF', async () => {
    const f = fixture();
    f.http.get.mockReturnValueOnce(of({ ...f.response, data: JSON.stringify({ ...catalog, approvals: [
      catalog.approvals[0], { ...catalog.approvals[0], approvalId: 'APPROVAL-B',
        evaluationUrl: 'https://floridabuilding.org/upload/PR_Tech_Docs/other.pdf' },
    ] }) }));
    await expect(f.service.findBatch('36')).resolves.toEqual({ systems: [{
      systemId: 36, systemName: 'Serie 700', brandName: 'Eco Windows Systems', productName: 'Sliding Glass Door', status: 'ambiguous',
    }] });
  });

  it.each([
    { status: 503 }, { data: '{}' }, { headers: { 'content-type': 'text/html' } },
    { data: JSON.stringify({ ...catalog, approvals: [{ ...catalog.approvals[0], evaluationUrl: {} }] }) },
    { data: JSON.stringify({ ...catalog, approvals: [{ ...catalog.approvals[0], officialUrl: false }] }) },
  ])('treats a broken upstream catalog as a failed batch, not missing approvals %#', async overrides => {
    const f = fixture();
    f.http.get.mockReturnValueOnce(of({ ...f.response, ...overrides }));
    await expect(f.service.findBatch('36,22')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.http.get).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to previous batch results after a timeout', async () => {
    const f = fixture();
    await f.service.findBatch('36,22');
    f.http.get.mockReturnValueOnce(throwError(() => new Error('private upstream timeout')));
    const error = await f.service.findBatch('36,22').catch(value => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error.getResponse())).not.toContain('private');
    expect(f.http.get).toHaveBeenCalledTimes(2);
  });
});
