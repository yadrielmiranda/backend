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
    disclosure: 'Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe from SMS or HELP for help.',
    registration: {
      serviceConsentText: `I agree to receive automated service notifications by SMS and email from ${companyName} about my estimates, installation appointments, orders, payments, and account activity at the phone number and email address I provide.`,
      serviceRequirement: 'Required to create an account.',
      promotionsConsentText: `I would also like to receive promotional SMS and emails from ${companyName}, including offers, discounts, and product news.`,
      promotionsDisclosure: 'Optional. Promotional consent is not required to create an account or make a purchase.',
    },
    terms: [
      { title: 'Service notifications', text: `${companyName} uses SMS and email for service notifications about estimates, installation appointments, orders, payments, and account activity. Message frequency varies with your activity. Service consent does not authorize promotional messages.` },
      { title: 'Creating an account', text: 'Creating an account requires selecting the checkbox authorizing service notifications by SMS and email. It starts unchecked. The account cannot be created without that acceptance. Review the disclosure, Messaging Terms, and Messaging Privacy Policy before submitting. You must be authorized to use the phone number and email address you provide.' },
      { title: 'Promotions', text: 'A second, independent checkbox authorizes promotional SMS and emails, including offers, discounts, and product news. It starts unchecked and is optional. Leaving it unchecked does not prevent account creation or a purchase. Selecting service notifications alone does not authorize promotions.' },
      { title: 'Service SMS preferences', text: 'Account holders can open Profile to review their saved phone number and manage service SMS notifications. To enable them, select the SMS checkbox and Save preference. This preference changes service SMS only; it does not authorize promotional messages or change email consent.' },
      { title: 'Charges and delivery', text: 'Message and data rates may apply according to your mobile carrier plan. Your carrier is not liable for delayed or undelivered messages. Delivery is not guaranteed. Check your account for current project and payment information.' },
      { title: 'Stop or resume messages', text: 'Reply STOP to unsubscribe. You may receive one confirmation of your cancellation. You can also turn off SMS notifications in Profile. After a STOP request, reply START to the same sending number to remove the carrier block, then enable SMS notifications again in Profile. Changing your account phone number requires a new authorization for that number.' },
      { title: 'Help', text: `Reply HELP for help. ${contactText}` },
      { title: 'Email preferences', text: `Promotional emails include an unsubscribe option. You can also contact us to withdraw permission for promotional messages or email notifications. ${contactText}` },
      { title: 'Privacy', text: 'Our Messaging Privacy Policy explains how we use your phone number, email address, and consent records. Permission for service notifications does not authorize marketing messages.' },
    ],
    privacy: [
      { title: 'Information we collect', text: 'We record your account identifier, phone number, email address, separate service and promotional choices, consent date, and the disclosure and policy version you accepted. We also keep unsubscribe records and identifiers of related SMS opt-in or opt-out messages.' },
      { title: 'How we use it', text: 'We use this information to provide service notifications, send promotions only with separate permission, manage your preferences, honor unsubscribe requests, assist you, and document your consent.' },
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
