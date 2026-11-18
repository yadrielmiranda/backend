const INTRO = 'Authentic Evolution: Welcome';
const OUTRO = '! Your account is ready. Access the portal to get started. Reply STOP to unsubscribe.';

// GSM-7 extension characters consume two septets, even though they look like
// one character. The fixed message uses only the single-septet alphabet.
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set('^{}\\[~]|€');
const NAME_BUDGET = 160 - INTRO.length - OUTRO.length - ', '.length;
const REPLACEMENTS: Record<string, string> = {
  '‘': "'", '’': "'", 'ʼ': "'", '“': '"', '”': '"',
  '‐': '-', '‑': '-', '–': '-', '—': '-',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Œ': 'OE', 'œ': 'oe',
};

function personalizedName(firstName?: string | null): string {
  if (!firstName) return '';
  let normalized = '';
  for (const original of firstName.normalize('NFC')) {
    if (/[\s\p{C}]/u.test(original)) {
      normalized += ' ';
      continue;
    }
    const character = REPLACEMENTS[original] ?? original;
    if (Array.from(character).every(value => GSM_BASIC.has(value) || GSM_EXTENDED.has(value))) {
      normalized += character;
      continue;
    }
    const simplified = character.normalize('NFKD').replace(/\p{M}/gu, '');
    if (simplified && Array.from(simplified).every(value => GSM_BASIC.has(value) || GSM_EXTENDED.has(value))) {
      normalized += simplified;
    } else if (/\p{L}/u.test(character)) {
      // Do not turn an unsupported-script name into a misleading fragment.
      return '';
    } else {
      normalized += ' ';
    }
  }
  normalized = normalized.replace(/\s+/g, ' ').trim();
  let name = '';
  let septets = 0;
  for (const character of normalized) {
    const width = GSM_EXTENDED.has(character) ? 2 : 1;
    if (septets + width > NAME_BUDGET) break;
    name += character;
    septets += width;
  }
  name = name.trim();
  return /\p{L}/u.test(name) ? name : '';
}

/** A complete service SMS, including sender and STOP, in one GSM-7 segment. */
export function renderWelcomeSms(firstName?: string | null): string {
  const name = personalizedName(firstName);
  return INTRO + (name ? ', ' + name : '') + OUTRO;
}
