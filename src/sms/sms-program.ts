import { createHash } from 'node:crypto';

export function buildSmsProgram(company: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
} | null) {
  const companyName = company?.name?.trim() || 'Authentic Evolution Co';
  const supportEmail = company?.email?.trim() || null;
  const supportPhone = company?.phone?.trim() || null;
  const support = [supportEmail, supportPhone].filter(Boolean).join(' or ');
  const contactText = support
    ? `For assistance, contact ${companyName} at ${support}.`
    : `For assistance, contact ${companyName} using the contact information on your estimate or order.`;

  const content = {
    companyName,
    supportEmail,
    supportPhone,
    effectiveDate: 'September 8, 2026',
    consentText: `I agree to receive automated text messages from ${companyName} about my estimates, installation appointments, orders, payments, and account activity at the phone number shown above.`,
    disclosure: 'Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Consent is optional and is not a condition of purchase.',
    terms: [
      { title: 'Messages you can receive', text: `${companyName} sends recurring automated service notifications about estimates, installation appointments, orders, payments, and account activity. Message frequency varies with your activity. This program does not include promotional or marketing messages.` },
      { title: 'Your choice', text: 'To join, sign in, open Profile, and select the optional SMS notifications checkbox for your saved phone number. Review the disclosure, SMS Terms, and SMS Privacy Policy, then select Save preference. The checkbox is unchecked until you choose to subscribe. Consent is not a condition of purchase. You must be authorized to use the phone number you provide.' },
      { title: 'Charges and delivery', text: 'Message and data rates may apply according to your mobile carrier plan. Your carrier is not liable for delayed or undelivered messages. Delivery is not guaranteed. Check your account for current project and payment information.' },
      { title: 'Stop or resume messages', text: 'Reply STOP to unsubscribe. You may receive one confirmation of your cancellation. You can also turn off SMS notifications in Profile. After a STOP request, reply START to the same sending number to remove the carrier block, then enable SMS notifications again in Profile. Changing your account phone number requires a new authorization for that number.' },
      { title: 'Help', text: `Reply HELP for help. ${contactText}` },
      { title: 'Privacy', text: 'Our SMS Privacy Policy explains how we use your phone number and messaging consent records. Permission for these service notifications does not authorize marketing messages.' },
    ],
    privacy: [
      { title: 'Information we collect', text: 'For this SMS program, we record your account identifier, phone number, subscription choices, consent date, and the disclosure and policy version you accepted. We also keep unsubscribe records and identifiers of related SMS opt-in or opt-out messages.' },
      { title: 'How we use it', text: 'We use this information to deliver the service notifications you request, manage your preferences, honor unsubscribe requests, assist you, and document your consent.' },
      { title: 'Sharing', text: 'We do not sell, rent, or share mobile numbers or SMS opt-in data and consent with third parties or affiliates for marketing or promotional purposes. We provide necessary information to messaging service providers, including Twilio and mobile carriers, solely to deliver and manage this SMS service. We may disclose information when required by law.' },
      { title: 'Your choices and records', text: 'You can unsubscribe by replying STOP or disabling SMS notifications in Profile. We keep consent and unsubscribe records as needed to document your choices, prevent unwanted messages, and meet applicable obligations. Removing your account does not automatically erase these historical records.' },
      { title: 'Contact', text: contactText },
    ],
  };

  // El mismo contenido se muestra y se guarda; cualquier cambio cambia su versión.
  return {
    ...content,
    version: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  };
}
