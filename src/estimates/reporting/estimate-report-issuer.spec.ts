import { DealerMode } from '@prisma/client';
import { buildExternalDealerPresentation } from './estimate-report-issuer';

function fixture(mode: DealerMode = 'EXTERNAL') {
  return {
    dealerModeSnapshot: mode,
    status: { name: 'Active' },
    user: {
      role: { name: 'dealer' },
      dealerMode: mode,
      firstName: ' Pepe ',
      lastName: ' Ernandez ',
      phone: ' +1 (999) 999-9999 ',
      email: ' pepe@example.com ',
    },
  };
}

const companyBranding = { type: 'COMPANY', isActive: true };
const owner = {
  name: 'Pepe Ernandez',
  phone: '+1 (999) 999-9999',
  email: 'pepe@example.com',
};

describe('external dealer report issuer', () => {
  it('uses only the external owner identity when Company branding is selected', () => {
    expect(buildExternalDealerPresentation(fixture(), companyBranding)).toEqual(owner);
  });

  it.each([1, 2, 3])('supports an external owner at network level %i', (depth) => {
    const estimate = fixture();
    if (depth > 1) {
      Object.assign(estimate, {
        dealerNetworkSnapshot: {
          version: 1,
          billingIndex: depth - 1,
          billingAccountId: depth,
          nodes: Array.from({ length: depth }, (_, index) => ({
            id: index + 1,
            mode: index === depth - 1 ? 'EXTERNAL' : 'INTERNAL',
          })),
        },
      });
      // The saved owner's mode takes precedence over current/root account mode.
      estimate.user.dealerMode = 'INTERNAL';
      estimate.dealerModeSnapshot = 'INTERNAL';
    }
    expect(buildExternalDealerPresentation(estimate, companyBranding)).toEqual(owner);
  });

  it.each([1, 2, 3])('keeps own active branding unchanged at network level %i', (depth) => {
    const estimate = fixture();
    if (depth > 1) {
      Object.assign(estimate, {
        dealerNetworkSnapshot: {
          version: 1,
          billingIndex: 0,
          billingAccountId: 1,
          nodes: Array.from({ length: depth }, (_, index) => ({
            id: index + 1,
            mode: 'EXTERNAL',
          })),
        },
      });
    }
    expect(buildExternalDealerPresentation(estimate, { type: 'DEALER', isActive: true })).toBeNull();
  });

  it('keeps internal and non-dealer accounts unchanged', () => {
    expect(buildExternalDealerPresentation(fixture('INTERNAL'), companyBranding)).toBeNull();
    const client = fixture();
    client.user.role.name = 'client';
    expect(buildExternalDealerPresentation(client, companyBranding)).toBeNull();
  });

  it('keeps a saved internal network owner unchanged', () => {
    const estimate = {
      ...fixture(),
      dealerNetworkSnapshot: {
        version: 1, billingIndex: 2, billingAccountId: 2,
        nodes: [{ id: 1, mode: 'INTERNAL' }, { id: 2, mode: 'INTERNAL' }],
      },
    };
    expect(buildExternalDealerPresentation(estimate, companyBranding)).toBeNull();
  });

  it('uses current mode for drafts and the saved mode for committed quotes', () => {
    const estimate = fixture('INTERNAL');
    estimate.user.dealerMode = 'EXTERNAL';
    expect(buildExternalDealerPresentation(estimate, companyBranding)).toEqual(owner);
    expect(buildExternalDealerPresentation({ ...estimate, payments: [{ status: 'PAID' }] }, companyBranding)).toBeNull();
    expect(buildExternalDealerPresentation({ ...estimate, order: { id: 1 } }, companyBranding)).toBeNull();
  });

  it('does not borrow Company contact information when owner contacts are missing', () => {
    const estimate = fixture();
    estimate.user.phone = ' ';
    estimate.user.email = '';
    const branding = { ...companyBranding, email: 'company@example.com', phone: '555-555-5555' };
    expect(buildExternalDealerPresentation(estimate, branding)).toEqual({ ...owner, phone: null, email: null });
    expect(buildExternalDealerPresentation(estimate, null)).toEqual({ ...owner, phone: null, email: null });
  });

  it('treats deactivated branding as absent and supplies a non-company fallback name', () => {
    const estimate = fixture();
    estimate.user.firstName = estimate.user.lastName = ' ';
    expect(buildExternalDealerPresentation(estimate, { type: 'DEALER', isActive: false }))
      .toEqual({ ...owner, name: 'Independent Distributor' });
  });
});
