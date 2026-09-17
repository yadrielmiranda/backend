import { BadRequestException } from '@nestjs/common';

// El contenido con formato se guarda en la misma columna de texto, con versión propia.
export const TERMS_RICH_TEXT_PREFIX = 'PLATFORM_TERMS_RICH_TEXT_V1\n';
export const TERMS_CONTENT_LIMIT = 500000;

export function validateTermsContent(content: string) {
  if (!content.startsWith(TERMS_RICH_TEXT_PREFIX)) return;
  const invalid = () => { throw new BadRequestException('The terms document has an unsupported format. Review it in the editor.'); };
  let document: any;
  try { document = JSON.parse(content.slice(TERMS_RICH_TEXT_PREFIX.length)); }
  catch { return invalid(); }
  const blocks = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'table'];
  const children: Record<string, string[]> = {
    doc: blocks,
    paragraph: ['text', 'hardBreak'], heading: ['text', 'hardBreak'],
    bulletList: ['listItem'], orderedList: ['listItem'],
    listItem: blocks,
    blockquote: blocks,
    table: ['tableRow'], tableRow: ['tableCell', 'tableHeader'],
    tableCell: blocks,
    tableHeader: blocks,
    text: [], hardBreak: [], horizontalRule: [],
  };
  let count = 0;
  let text = '';
  function visit(node: any, depth: number) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 20 || ++count > 15000 ||
        !Object.prototype.hasOwnProperty.call(children, node.type)) return invalid();
    if (node.type === 'text') {
      if (typeof node.text !== 'string') return invalid();
      text += node.text;
    } else if (node.text !== undefined) return invalid();
    const attrs = node.attrs;
    if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs))) return invalid();
    const integer = (value: unknown, max: number) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= max;
    if (node.type === 'heading' && !integer(attrs?.level, 6)) return invalid();
    if (attrs?.start != null && !integer(attrs.start, 1000000)) return invalid();
    if (attrs?.value != null && !integer(attrs.value, 1000000)) return invalid();
    if (attrs?.colspan != null && !integer(attrs.colspan, 100)) return invalid();
    if (attrs?.rowspan != null && !integer(attrs.rowspan, 1000)) return invalid();
    if (node.marks != null) {
      if (!['text', 'hardBreak'].includes(node.type) || !Array.isArray(node.marks) || node.marks.length > 6) return invalid();
      for (const mark of node.marks) {
        if (!mark || !['bold', 'italic', 'underline', 'strike', 'link'].includes(mark.type)) return invalid();
        if (mark.type === 'link' && (typeof mark.attrs?.href !== 'string' ||
            !/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(mark.attrs.href.trim()))) return invalid();
      }
    }
    if (node.content != null) {
      if (!Array.isArray(node.content)) return invalid();
      for (const child of node.content) {
        if (!children[node.type].includes(child?.type)) return invalid();
        visit(child, depth + 1);
      }
    }
  }
  if (document?.type !== 'doc') return invalid();
  visit(document, 0);
  if (!text.trim()) throw new BadRequestException('Enter the terms text before publishing.');
}
