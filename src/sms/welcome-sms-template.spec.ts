import { renderWelcomeSms } from './welcome-sms-template';

const fallback = 'Authentic Evolution: Welcome! Your account is ready. Access the portal to get started. Reply STOP to unsubscribe.';
// Independent count against the GSM-7 tables: unsupported characters fail the
// test instead of silently being counted as a single septet.
const basic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const extended = '^{}\\[~]|€';
function septetCount(text: string): number {
  return Array.from(text).reduce((total, character) => {
    if (basic.includes(character)) return total + 1;
    if (extended.includes(character)) return total + 2;
    throw new Error('Non-GSM-7 character: ' + character);
  }, 0);
}

describe('welcome SMS template', () => {
  it.each([undefined, null, '', '   ', '\r\n\t', '😀', '12345', '李明', 'Алексей', 'Anna李'])(
    'uses the approved fallback for an unusable name: %s', firstName => {
      expect(renderWelcomeSms(firstName)).toBe(fallback);
      expect(septetCount(renderWelcomeSms(firstName))).toBe(113);
    },
  );

  it('adds only the first name without changing the approved message or footer', () => {
    expect(renderWelcomeSms('Yadriel')).toBe(
      'Authentic Evolution: Welcome, Yadriel! Your account is ready. Access the portal to get started. Reply STOP to unsubscribe.',
    );
  });

  it.each([
    ['José Peña', 'José Peña'],
    ['Jose\u0301 Pen\u0303a', 'José Peña'],
    ['María', 'Maria'],
    ['Łukasz', 'Lukasz'],
    ['D’Arcy', "D'Arcy"],
    ['Anne–Marie', 'Anne-Marie'],
    [' \tAna\r\n  Maria\u0000 ', 'Ana Maria'],
    ['Ana 😀', 'Ana'],
    ['\ud800Ana\udfff', 'Ana'],
  ])('keeps %s readable without switching the message encoding', (input, expected) => {
    const message = renderWelcomeSms(input);
    expect(message).toBe(fallback.replace('Welcome!', 'Welcome, ' + expected + '!'));
    expect(septetCount(message)).toBeLessThanOrEqual(160);
  });

  it('caps an unusually long name while retaining every word of the message and STOP', () => {
    const message = renderWelcomeSms('A'.repeat(500));
    expect(message).toBe(fallback.replace('Welcome!', 'Welcome, ' + 'A'.repeat(45) + '!'));
    expect(septetCount(message)).toBe(160);
  });

  it('counts extension characters twice at the one-segment boundary', () => {
    const message = renderWelcomeSms('A' + '^{}\\[~]|€'.repeat(30));
    expect(septetCount(message)).toBe(160);
    expect(message.endsWith('Reply STOP to unsubscribe.')).toBe(true);
  });

  it.each([
    'é'.repeat(1000), '😀'.repeat(1000), '\u0301'.repeat(1000),
    'Marie ^'.repeat(1000), ' \u0000\u200dAna '.repeat(100),
  ])('always keeps malformed or unusually long input in one segment', input => {
    const message = renderWelcomeSms(input);
    expect(septetCount(message)).toBeLessThanOrEqual(160);
    expect(message.startsWith('Authentic Evolution: Welcome')).toBe(true);
    expect(message.endsWith('Reply STOP to unsubscribe.')).toBe(true);
    expect(message.match(/Reply STOP/g)).toHaveLength(1);
  });
});
