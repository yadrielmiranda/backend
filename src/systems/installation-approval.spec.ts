import {
  INSTALLATION_APPROVAL_CATALOG_SCHEMA, officialInstallationPdf, officialApprovalUrl,
  parseInstallationApprovalCatalog, resolveInstallationApproval, resolveProductApproval,
  type ApprovalSystemIdentity, type InstallationApprovalRecord,
} from './installation-approval';

const firstPdf = 'https://floridabuilding.org/upload/PR_Instl_Docs/installation-a.pdf';
const secondPdf = 'https://floridabuilding.org/upload/PR_Instl_Docs/installation-b.pdf';
const evaluationPdf = 'https://floridabuilding.org/upload/PR_Tech_Docs/evaluation.pdf';
const officialPage = 'https://floridabuilding.org/pr/pr_app_dtl.aspx?param=record%2fA';
const now = new Date('2026-11-16T17:00:00Z');
const system: ApprovalSystemIdentity = {
  name: 'Serie 700', brandName: 'Eco Windows Systems', productName: 'Sliding Glass Door',
};
function approval(overrides: Partial<InstallationApprovalRecord> = {}): InstallationApprovalRecord {
  return {
    brand: 'ECO Window Systems', series: '700', product: 'Sliding Glass Door', variant: 'LMI',
    approvalId: 'APPROVAL-A', status: 'Approved', archived: false, eligibleForCurrentDocumentList: true,
    expiresDate: null, installationUrl: firstPdf, documents: [], ...overrides,
  };
}
const resolve = (rows: InstallationApprovalRecord[], identity = system) => resolveInstallationApproval(identity, rows, now);

describe('Installation approval matching', () => {
  it('requires matching brand, whole series and product and returns only the installation link', () => {
    const rows = [approval()];
    expect(resolve(rows)).toEqual({ status: 'available', url: firstPdf, approvalId: 'APPROVAL-A', variant: 'LMI' });
    for (const identity of [
      { ...system, brandName: 'Eco Novo Systems' }, { ...system, brandName: 'Other Eco Windows Systems' },
      { ...system, name: 'Serie 70' }, { ...system, name: 'Serie 700 Special' },
      { ...system, name: 'Serie 1700' }, { ...system, productName: 'French Door' },
      { ...system, productName: 'Sliding Glass Door Repair' },
    ]) expect(resolve(rows, identity)).toEqual({ status: 'not_found' });
  });

  it.each([
    ['Eco Windows Systems', 'Serie 50', 'Single Hung Window', 'ECO Window Systems', '50', 'Single Hung'],
    ['Eco Windows Systems', 'Serie 60', 'Horizontal Rolling Window', 'ECO Window Systems', '60', 'Horizontal Roller'],
    ['Eco Windows Systems', 'Serie 900 Bi-Fold', 'Bi-Fold Door', 'ECO Window Systems', '900', 'Bi-Fold'],
    ['Eco Windows Systems', 'Serie 800', 'French Door', 'ECO Window Systems', '800', 'Puerta abatible hacia afuera'],
    ['Eco Windows Systems', 'Serie 810', 'French Door', 'ECO Window Systems', '810', 'Puerta abatible hacia afuera'],
    ['Eco Novo Systems', 'Serie 675', 'French Door', 'ECO NOVO', '675', 'French Door y Sidelite'],
    ['Eco Windows Systems', 'Serie 1500', 'Pivot Door', 'ECO Window Systems', '1500', 'Puerta Pivot'],
    ['Eco Windows Systems', 'Serie 750', 'Garage Door', 'ECO Window Systems', '750', 'Puerta seccional de garaje'],
    ['Eco Windows Systems', 'Serie 400', 'Window Wall-Store Front', 'ECO Window Systems', '400', 'Window Wall'],
    ['Eco Windows Systems', 'Serie 450', 'Window Wall-Store Front', 'ECO Window Systems', '450', 'Window Wall'],
    ['Eco Windows Systems', 'Serie 500', 'Casement Window', 'ECO Window Systems', '500', 'Casement'],
    ['Eco Windows Systems', 'Serie 550', 'Casement Window', 'ECO Window Systems', '550', 'Fixed Window'],
    ['Eco Windows Systems', 'Serie 560', 'Casement Window', 'ECO Window Systems', '560', 'Awning'],
    ['Eco Novo Systems', 'Serie 575', 'Casement Window', 'ECO NOVO', '575', 'Casement'],
    ['Eco Novo Systems', 'Serie 585', 'Casement Window', 'ECO NOVO', '585', 'Awning'],
    ['Eco Novo Systems', 'Serie 595', 'Casement Window', 'ECO NOVO', '595', 'Fixed Casement'],
  ])('uses the verified %s / %s / %s alias', (brandName, name, productName, brand, series, product) => {
    expect(resolve([approval({ brand, series, product })], { brandName, name, productName }).status).toBe('available');
  });

  it.each([
    ['475', 'Storefront', 'Window Wall-Store Front', 'FL21632.5-R6'],
    ['870', 'Puerta seccional de garaje', 'Garage Door', 'FL47490.1-R1'],
    ['875', 'Puerta seccional de garaje', 'Garage Door', 'FL47490.2-R1'],
  ])('uses the explicitly confirmed NOVO %s catalog equivalence', (series, product, productName, approvalId) => {
    const installationUrl = `https://floridabuilding.org/upload/PR_Instl_Docs/series-${series}.pdf`;
    const rows = [approval({ series, product, approvalId, installationUrl, variant: 'LMI + SMI' })];
    expect(resolve(rows, { name: `Serie ${series}`, brandName: 'Eco Novo Systems', productName }))
      .toEqual({ status: 'available', url: installationUrl, approvalId, variant: 'LMI + SMI' });
    for (const identity of [
      { name: `Serie ${series}`, brandName: 'Other Eco Novo Systems', productName },
      { name: `Serie ${series}`, brandName: 'Eco Novo Systems', productName: 'French Door' },
      { name: `Serie ${series} Special`, brandName: 'Eco Novo Systems', productName },
    ]) expect(resolve(rows, identity)).toEqual({ status: 'not_found' });
  });

  it('keeps approval and impact eligibility checks for the confirmed NOVO aliases', () => {
    for (const [series, product, productName] of [
      ['475', 'Storefront', 'Window Wall-Store Front'],
      ['870', 'Puerta seccional de garaje', 'Garage Door'],
      ['875', 'Puerta seccional de garaje', 'Garage Door'],
    ]) {
      const identity = { name: `Serie ${series}`, brandName: 'Eco Novo Systems', productName };
      const current = approval({ series, product, variant: 'LMI + SMI' });
      const pending = approval({ series, product, approvalId: 'NEWER-PENDING', status: 'Pending FBC Approval', installationUrl: secondPdf });
      expect(resolve([pending, current], identity)).toMatchObject({ status: 'available', url: firstPdf });
      for (const overrides of [{ variant: 'SMI' }, { archived: true }, { eligibleForCurrentDocumentList: false }])
        expect(resolve([{ ...current, ...overrides }], identity)).toEqual({ status: 'not_found' });
    }
  });

  it('does not extend the confirmed equivalences to other NOVO series or products', () => {
    expect(resolve([approval({ series: '750', product: 'Puerta seccional de garaje' })], {
      brandName: 'Eco Novo Systems', name: 'Serie 750', productName: 'Garage Door',
    })).toEqual({ status: 'not_found' });
    expect(resolve([approval({ series: '475', product: 'Window Wall' })], {
      brandName: 'Eco Novo Systems', name: 'Serie 475', productName: 'Window Wall-Store Front',
    })).toEqual({ status: 'not_found' });
    expect(resolve([approval({ series: '870', product: 'French Door' })], {
      brandName: 'Eco Novo Systems', name: 'Serie 870', productName: 'French Door',
    })).toEqual({ status: 'not_found' });
    expect(resolve([approval({ brand: 'ECO NOVO', series: '870', product: 'Puerta seccional de garaje' })], {
      brandName: 'Eco Windows Systems', name: 'Serie 870', productName: 'Garage Door',
    })).toEqual({ status: 'not_found' });
    expect(resolve([approval({ series: '500', product: 'Fixed Window' })], {
      brandName: system.brandName, name: 'Serie 500', productName: 'Casement Window',
    })).toEqual({ status: 'not_found' });
  });

  it.each(['SMI', 'NI — SIN IMPACTO', 'Componente; ver plano', 'LMI pending', 'LMI/SMI'])(
    'excludes variant %s', variant => expect(resolve([approval({ variant })])).toEqual({ status: 'not_found' }),
  );
  it.each(['LMI + SMI', 'LMI+SMI'])(
    'accepts the combined impact variant %s', variant =>
      expect(resolve([approval({ variant })])).toMatchObject({ status: 'available', variant: 'LMI + SMI' }),
  );
  it.each([
    { status: 'Pending' }, { status: 'Approved pending conditions' }, { archived: true },
    { eligibleForCurrentDocumentList: false }, { expiresDate: '2026-11-15' },
  ])('excludes an ineligible record %j', overrides => expect(resolve([approval(overrides)])).toEqual({ status: 'not_found' }));
  it('uses the explicit approval expiry date through its Florida calendar day', () => {
    expect(resolve([approval({ expiresDate: '2026-11-16' })]).status).toBe('available');
    expect(resolve([approval({ expiresDate: '2026-11-17' })]).status).toBe('available');
    expect(resolveInstallationApproval(system, [approval({ expiresDate: '2026-11-15' })], new Date('2026-11-16T02:00:00Z')).status)
      .toBe('available');
  });
  it('uses installationUrl first and never substitutes an evaluation or registry document', () => {
    expect(resolve([approval({ documents: [{ type: 'installation', url: secondPdf }] })])).toMatchObject({ url: firstPdf });
    expect(resolve([approval({ installationUrl: null, documents: [{ type: 'installation', url: secondPdf }] })])).toMatchObject({ url: secondPdf });
    expect(resolve([approval({ installationUrl: null, documents: [{ type: 'evaluation', url: firstPdf }] })])).toEqual({ status: 'not_found' });
    expect(resolve([approval({ installationUrl: 'https://untrusted.example/x.pdf', documents: [{ type: 'installation', url: secondPdf }] })]))
      .toEqual({ status: 'not_found' });
  });
  it('accepts an official complete NOA only when explicitly assigned as the installation URL', () => {
    const url = 'https://www.miamidade.gov/building/library/productcontrol/noa/example.pdf';
    const row = approval({ status: 'File Approved', archived: null, installationUrl: url, documents: [{ type: 'noa_complete', url }] });
    expect(resolve([row])).toMatchObject({ status: 'available', url });
    expect(resolve([{ ...row, installationUrl: null }])).toEqual({ status: 'not_found' });
  });
  it('deduplicates one PDF but refuses distinct PDFs, including within one installation document list', () => {
    const same = approval({ approvalId: 'APPROVAL-B', installationUrl: firstPdf.replace('https://', 'https://www.') + '#page=2' });
    expect(resolve([same, approval()])).toEqual(resolve([approval(), same]));
    expect(resolve([same, approval()])).toMatchObject({ status: 'available', approvalId: 'APPROVAL-A' });
    expect(resolve([approval(), approval({ approvalId: 'APPROVAL-B', installationUrl: secondPdf })])).toEqual({ status: 'ambiguous' });
    expect(resolve([approval({ installationUrl: null, documents: [
      { type: 'installation', url: firstPdf }, { type: 'installation', url: secondPdf },
    ] })])).toEqual({ status: 'ambiguous' });
  });
  it('reports conflicting garage models as ambiguous rather than selecting the first', () => {
    const identity = { ...system, name: 'Serie 850', productName: 'Garage Door' };
    const rows = [firstPdf, secondPdf].map((installationUrl, index) => approval({
      series: '850', product: 'Puerta seccional de garaje', approvalId: `APPROVAL-${index}`, installationUrl,
    }));
    expect(resolve(rows, identity)).toEqual({ status: 'ambiguous' });
  });
});

describe('Approval catalog and link boundaries', () => {
  it('accepts only the expected schema and approval records, ignoring excluded and pending lists', () => {
    expect(parseInstallationApprovalCatalog({ schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: [], pending: [approval()], excluded: [approval()] }))
      .toEqual([]);
    expect(parseInstallationApprovalCatalog({ schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: [approval()] })).toEqual([approval()]);
  });
  it('accepts a mixed catalog whose current NOA omits archived, while checking its explicit expiry', () => {
    const noa = approval({
      series: '1000', product: 'Baranda de aluminio y vidrio', approvalId: 'NOA-A', status: 'File Approved',
      expiresDate: '2029-03-14', installationUrl: 'https://www.miamidade.gov/building/library/productcontrol/noa/example.pdf',
    });
    delete noa.archived;
    const rows = parseInstallationApprovalCatalog({ schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: [approval(), noa] });
    expect(resolve(rows).status).toBe('available');
    const identity = { ...system, name: 'Serie 1000', productName: 'Baranda de aluminio y vidrio' };
    expect(resolve(rows, identity)).toMatchObject({ status: 'available', approvalId: 'NOA-A' });
    expect(resolveInstallationApproval(identity, rows, new Date('2029-03-15T17:00:00Z'))).toEqual({ status: 'not_found' });
  });
  it.each([
    null, [], {}, { schema: 'v2', approvals: [] }, { schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: {} },
    ...[
      null, { ...approval(), brand: '' }, { ...approval(), archived: 'false' },
      { ...approval(), eligibleForCurrentDocumentList: 'true' }, { ...approval(), expiresDate: '2026-02-30' },
      { ...approval(), expiresDate: 'not a date' }, { ...approval(), installationUrl: {} },
      { ...approval(), evaluationUrl: 3 }, { ...approval(), officialUrl: {} },
      { ...approval(), evaluationUrl: 'a'.repeat(2049) }, { ...approval(), officialUrl: 'a'.repeat(2049) },
      { ...approval(), documents: [{ type: 'installation', url: 1 }] },
    ].map(row => ({ schema: INSTALLATION_APPROVAL_CATALOG_SCHEMA, approvals: [row] })),
  ])('rejects invalid schema %j', value => expect(() => parseInstallationApprovalCatalog(value)).toThrow());
  it.each([
    'http://floridabuilding.org/x.pdf', 'javascript:alert(1)', '//floridabuilding.org/x.pdf',
    'https://floridabuilding.org.evil.example/x.pdf', 'https://evil.example/floridabuilding.org/x.pdf',
    'https://floridabuilding.org@evil.example/x.pdf', 'https://user@floridabuilding.org/x.pdf',
    'https://floridabuilding.org:444/x.pdf', 'https://floridabuilding.org/x.html?file=a.pdf',
    'https://floridabuilding.org/x.pdf/extra', 'https://floridabuilding.org/x%0a.pdf',
    'https://floridabuilding.org/a\\b.pdf',
  ])('rejects a non-official or unsafe PDF target %s', value => expect(officialInstallationPdf(value)).toBeNull());
  it.each(['floridabuilding.org', 'www.floridabuilding.org', 'miamidade.gov', 'www.miamidade.gov'])(
    'accepts HTTPS PDF paths on %s', host => expect(officialInstallationPdf(`https://${host}/plans/a%20b.PDF`))
      .toBe(`https://${host}/plans/a%20b.PDF`),
  );
});

describe('Product approval document bundles', () => {
  const allLinks = () => approval({ evaluationUrl: evaluationPdf, officialUrl: officialPage });
  const bundle = (rows: InstallationApprovalRecord[], identity = system) => resolveProductApproval(identity, rows, now);

  it('returns the three independently classified URLs without changing the installation-only contract', () => {
    expect(bundle([allLinks()])).toEqual({
      status: 'available', approvalId: 'APPROVAL-A', variant: 'LMI',
      installationUrl: firstPdf, evaluationUrl: evaluationPdf, officialUrl: officialPage,
    });
    expect(resolve([allLinks()])).toEqual({ status: 'available', url: firstPdf, approvalId: 'APPROVAL-A', variant: 'LMI' });
    expect(officialApprovalUrl(officialPage)).toBe(officialPage);
    expect(officialInstallationPdf(officialPage)).toBeNull();
  });

  it('prefers each direct field and uses only the same document type as fallback', () => {
    const row = allLinks();
    row.documents = [
      { type: 'installation', url: secondPdf }, { type: 'evaluation', url: secondPdf },
      { type: 'official', url: 'https://miamidade.gov/approval/other' },
    ];
    expect(bundle([row])).toMatchObject({ installationUrl: firstPdf, evaluationUrl: evaluationPdf, officialUrl: officialPage });
    expect(bundle([{ ...row, installationUrl: null, evaluationUrl: null, officialUrl: null }])).toMatchObject({
      installationUrl: secondPdf, evaluationUrl: secondPdf, officialUrl: 'https://miamidade.gov/approval/other',
    });
    expect(bundle([approval({ installationUrl: null, documents: [{ type: 'evaluation', url: evaluationPdf }] })]))
      .toEqual({ status: 'available', approvalId: 'APPROVAL-A', variant: 'LMI', evaluationUrl: evaluationPdf });
    expect(bundle([approval({ installationUrl: null, documents: [{ type: 'noa_complete', url: firstPdf }] })]))
      .toEqual({ status: 'not_found' });
  });

  it.each(['installationUrl', 'evaluationUrl', 'officialUrl'] as const)(
    'refuses conflicting %s even when the other links agree', key => {
      const rows = [allLinks(), { ...allLinks(), approvalId: 'APPROVAL-B', [key]: secondPdf }];
      expect(bundle(rows)).toEqual({ status: 'ambiguous' });
      expect(bundle([...rows].reverse())).toEqual({ status: 'ambiguous' });
      if (key !== 'installationUrl') expect(resolve(rows).status).toBe('available');
    },
  );

  it.each(['installation', 'evaluation', 'official'] as const)('refuses multiple distinct %s fallback documents', kind => {
    expect(bundle([approval({ installationUrl: null, documents: [
      { type: kind, url: firstPdf }, { type: kind, url: secondPdf },
    ] })])).toEqual({ status: 'ambiguous' });
  });

  it('deduplicates all three links and chooses stable metadata only for the same document set', () => {
    const duplicate = { ...allLinks(), approvalId: 'APPROVAL-B',
      installationUrl: firstPdf.replace('https://', 'https://www.') + '#page=2',
      evaluationUrl: evaluationPdf.replace('https://', 'https://www.') + '#page=3',
      officialUrl: officialPage.replace('https://', 'https://www.') + '#details',
    };
    const result = bundle([duplicate, allLinks()]);
    expect(result).toEqual(bundle([allLinks(), duplicate]));
    expect(result).toMatchObject({ status: 'available', approvalId: 'APPROVAL-A' });
  });

  it('does not manufacture a complete approval from separate complementary records', () => {
    const installationOnly = approval();
    const evaluationOnly = approval({ approvalId: 'APPROVAL-B', installationUrl: null, evaluationUrl: evaluationPdf });
    expect(bundle([installationOnly, evaluationOnly])).toEqual({ status: 'ambiguous' });
    expect(bundle([installationOnly, { ...allLinks(), approvalId: 'APPROVAL-B' }]))
      .toMatchObject({ status: 'available', approvalId: 'APPROVAL-B', officialUrl: officialPage });
  });

  it('omits unsafe or wrong-kind URLs and never substitutes fallback for an unsafe direct value', () => {
    expect(bundle([approval({ installationUrl: null, evaluationUrl: officialPage, officialUrl: 'https://evil.example/x.pdf' })]))
      .toEqual({ status: 'not_found' });
    expect(bundle([approval({
      installationUrl: null, evaluationUrl: 'https://evil.example/x.pdf', officialUrl: officialPage,
      documents: [{ type: 'evaluation', url: evaluationPdf }],
    })])).toEqual({ status: 'available', approvalId: 'APPROVAL-A', variant: 'LMI', officialUrl: officialPage });
  });

  it.each([
    'http://floridabuilding.org/record', 'https://evil.example/record', 'javascript:alert(1)',
    'https://floridabuilding.org.evil.example/record', 'https://user@floridabuilding.org/record',
    'https://floridabuilding.org:444/record', 'https://floridabuilding.org/rec%0aord',
  ])('rejects unsafe official registry link %s', value => expect(officialApprovalUrl(value)).toBeNull());

  it('applies current impact, approval, expiry and product boundaries to every link', () => {
    for (const changes of [
      { archived: true }, { eligibleForCurrentDocumentList: false }, { status: 'Pending' },
      { expiresDate: '2026-11-15' }, { variant: 'SMI' }, { product: 'French Door' },
    ]) expect(bundle([{ ...allLinks(), ...changes }])).toEqual({ status: 'not_found' });
  });

  it.each([
    ['475', 'Storefront', 'Window Wall-Store Front'],
    ['870', 'Puerta seccional de garaje', 'Garage Door'],
    ['875', 'Puerta seccional de garaje', 'Garage Door'],
  ])('preserves the confirmed NOVO %s equivalence and combined impact variant', (series, product, productName) => {
    expect(bundle([{ ...allLinks(), series, product, variant: 'LMI + SMI' }], {
      name: `Serie ${series}`, brandName: 'Eco Novo Systems', productName,
    })).toMatchObject({ status: 'available', variant: 'LMI + SMI', installationUrl: firstPdf, evaluationUrl: evaluationPdf, officialUrl: officialPage });
  });
});
