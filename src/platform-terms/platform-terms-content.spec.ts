import { TERMS_RICH_TEXT_PREFIX, validateTermsContent } from './platform-terms-content';

const rich = (content: any[]) => TERMS_RICH_TEXT_PREFIX + JSON.stringify({ type: 'doc', content });
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('Imported platform terms content', () => {
  it('keeps legacy text and markup-like literals supported', () => {
    for (const content of ['## Existing terms\n\nExisting paragraph.', '<script>literal example</script>'])
      expect(() => validateTermsContent(content)).not.toThrow();
  });

  it('accepts a complete long document with all sections and formatted text', () => {
    const document = rich(Array.from({ length: 40 }, (_, index) => [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Section ${index + 1}` }] },
      ...Array.from({ length: 8 }, () => paragraph('Example terms paragraph with every original word retained. '.repeat(6))),
    ]).flat());
    expect(document.length).toBeGreaterThan(120000);
    expect(() => validateTermsContent(document)).not.toThrow();
  });

  it('accepts headings, lists, tables and safe links without permitting HTML execution', () => {
    const document = rich([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Conditions' }] },
      { type: 'orderedList', attrs: { start: 4 }, content: [
        { type: 'listItem', attrs: { value: 4 }, content: [paragraph('Fourth condition')] },
        { type: 'listItem', attrs: { value: 7 }, content: [paragraph('Seventh condition'),
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Included subheading' }] }] },
      ] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [paragraph('Table content')] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '<script>literal</script>', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.test/terms' } }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Formatted line break' }, { type: 'hardBreak', marks: [{ type: 'bold' }] }] },
    ]);
    expect(() => validateTermsContent(document)).not.toThrow();
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'vbscript:test'])('rejects unsafe link %s', href => {
    const document = rich([{ type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }] }]);
    expect(() => validateTermsContent(document)).toThrow('unsupported format');
  });

  it('rejects malformed, empty and unsupported document nodes', () => {
    for (const document of [TERMS_RICH_TEXT_PREFIX + '{', rich([]), rich([paragraph('   ')]),
      rich([{ type: 'iframe', attrs: { src: 'https://example.test' } }]),
      rich([{ type: 'heading', attrs: { level: 99 }, content: [paragraph('Invalid heading')] }])])
      expect(() => validateTermsContent(document)).toThrow();
  });

  it('bounds nesting depth', () => {
    let node: any = paragraph('Nested text');
    for (let index = 0; index < 25; index++) node = { type: 'blockquote', content: [node] };
    expect(() => validateTermsContent(rich([node]))).toThrow('unsupported format');
  });
});
