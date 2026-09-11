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
    effectiveDate: 'September 10, 2026',
    consentText: `I agree to receive automated service SMS from ${companyName} about my estimates, installation appointments, orders, payments, and account activity at the phone number shown above.`,
    disclosure: 'Both SMS options are optional. Consent is not a condition of creating an account, using the service, or making a purchase. Message frequency varies. Message and data rates may apply. You can turn off either SMS category in Profile and select Save preferences. Reply STOP to unsubscribe from all SMS or HELP for help.',
    registration: {
      serviceConsentText: `I agree to receive automated service SMS from ${companyName} about my estimates, installation appointments, orders, payments, and account activity at the phone number I provide.`,
      serviceRequirement: 'Optional. You can create an account and use the service without receiving SMS.',
      promotionsConsentText: `I agree to receive automated promotional SMS from ${companyName}, including offers, discounts, and product news, at the phone number I provide.`,
      promotionsDisclosure: 'Optional and independent from service SMS. Consent is not required to create an account, use the service, or make a purchase.',
    },
    terms: [
      { title: 'Service SMS', text: `${companyName} offers optional SMS about estimates, installation appointments, orders, payments, and account activity. Message frequency varies with your activity. Service SMS consent does not authorize promotional messages.` },
      { title: 'Optional consent', text: 'The service SMS and promotional SMS checkboxes are separate, optional, and initially unchecked. You may select either, both, or neither. Consent to SMS is not a condition of creating an account, using the service, or making a purchase. Review these SMS Terms and the SMS Privacy Policy before subscribing. You must be authorized to use the phone number you provide.' },
      { title: 'Promotional SMS', text: 'A separate checkbox authorizes promotional SMS, including offers, discounts, and product news. Promotional consent does not authorize service SMS, and service consent does not authorize promotions. Message frequency varies.' },
      { title: 'SMS preferences', text: 'Account holders can open Profile to review their saved phone number and manage service SMS and promotional SMS independently. Select or clear each checkbox and choose Save preferences. Turning off one SMS category does not turn off the other.' },
      { title: 'Charges and delivery', text: 'Message and data rates may apply according to your mobile carrier plan. Your carrier is not liable for delayed or undelivered messages. Delivery is not guaranteed. Check your account for current project and payment information.' },
      { title: 'Stop or resume messages', text: 'Reply STOP to unsubscribe from all SMS sent by this program. You may receive one confirmation of your cancellation. You can also turn off either SMS category in Profile. After a STOP request, reply START to the same sending number to remove the carrier block, then select your SMS preferences again in Profile. Changing your account phone number requires a new authorization for that number.' },
      { title: 'Help', text: `Reply HELP for help. ${contactText}` },
      { title: 'Privacy', text: 'Our SMS Privacy Policy explains how we use your phone number and SMS consent records. Each permission applies only to its selected SMS category.' },
    ],
    privacy: [
      { title: 'Information we collect', text: 'For this SMS program, we record your account identifier, phone number, separate service and promotional SMS choices, consent date, and the disclosure and policy version you accepted. We also keep unsubscribe records and identifiers of related SMS opt-in or opt-out messages.' },
      { title: 'How we use it', text: 'We use this information to send SMS in the categories you authorize, manage your SMS preferences, honor unsubscribe requests, assist you, and document your choices.' },
      { title: 'Sharing', text: 'We do not sell, rent, or share mobile numbers or SMS opt-in data and consent with third parties or affiliates for marketing or promotional purposes. We provide necessary information to messaging service providers, including Twilio and mobile carriers, solely to deliver and manage this SMS service. We may disclose information when required by law.' },
      { title: 'Your choices and records', text: 'You can unsubscribe from all program SMS by replying STOP or manage each SMS category in Profile. We keep consent and unsubscribe records as needed to document your choices, prevent unwanted messages, and meet applicable obligations. Removing your account does not automatically erase these historical records.' },
      { title: 'Contact', text: contactText },
    ],
  };

  // El mismo contenido se muestra y se guarda; las versiones antiguas permanecen intactas.
  return {
    ...content,
    version: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  };
}
