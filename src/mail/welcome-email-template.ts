import { renderRegistrationResultEmail } from '@/dealer-network/dealer-registration-result-template';

export type AccountWelcomeEmailContent = {
  firstName: string;
  username: string;
  roleName: string;
  isDealerApproval?: boolean;
};

export type WelcomeEmailTemplateInput = AccountWelcomeEmailContent & {
  companyName: string;
  origin: string;
  supportEmail: string;
  supportPhone?: string;
};

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');

/** Pure template: origin is supplied by the server's notification email configuration. */
export function renderWelcomeEmail(input: WelcomeEmailTemplateInput) {
  const origin = new URL(input.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('Invalid welcome email origin.');
  const company = clean(input.companyName).slice(0, 100);
  if (input.isDealerApproval) return renderRegistrationResultEmail(true, company, origin.origin);
  const firstName = clean(input.firstName).slice(0, 100);
  const role = clean(input.roleName).toLowerCase();
  const technician = role === 'technician';
  const title = role === 'dealer' ? 'Your dealer account is ready' : technician ? 'Your technician account is ready'
    : role === 'client' ? 'Your client account is ready' : 'Your account is ready';
  const subject = role === 'client' ? `Welcome to ${company} — Start your next project`
    : `Welcome to ${company} — ${title}`;
  const paragraphs = role === 'client' ? [
    `Welcome to ${company}! Your client account is ready.`,
    'Thank you for choosing us and giving us the opportunity to be part of your upcoming projects.',
    'You can now use our portal to quote impact windows and doors, explore pricing for the options you need, and plan your project at your own pace.',
    'Take a first look: start with a window or door for your next project and prepare your first estimate.',
  ] : role === 'dealer' ? [
    `Welcome to ${company}! Your dealer account is ready.`,
    'Thank you for giving us the opportunity to support your business and your upcoming projects.',
    'Through our portal, you can quote impact windows and doors, explore product options and pricing, and manage your estimates and orders.',
    'Get started with a window or door for your next customer project and prepare your first estimate.',
  ] : technician ? [
    `Welcome to ${company}! Your technician account is ready.`,
    'Open your technician workspace to access the work and tools available to your account.',
  ] : [
    `Welcome to ${company}! Your account is ready.`,
    'Open the portal to access the workspace and tools available to your account.',
  ];
  const label = role === 'client' || role === 'dealer' ? 'Start quoting' : technician ? 'Open technician portal' : 'Access portal';
  const link = new URL(technician ? '/technician' : '/login', origin.origin).href;
  const logo = new URL('/branding/authentic-login-logo.png', origin.origin).href;
  const signIn = technician
    ? 'Sign in with your technician username. This contact email is for messages only. If you need help with your password, contact your administrator.'
    : 'Sign in with your username or email address. If you don’t know your password, select “Forgot your password?” on the sign-in page.';
  const help = role === 'dealer' ? 'Need help getting started? Reply to this email or contact our team. We are here to support you.'
    : 'Need guidance getting started? Reply to this email or contact our team. We are here to help.';
  const closing = role === 'dealer' ? 'We look forward to working with you,' : 'Thank you for choosing us,';
  const supportEmail = clean(input.supportEmail);
  const phone = clean(input.supportPhone || '+1 (786) 999-4224');
  const phoneHref = phone.replace(/[^+\d]/g, '');
  return {
    subject: Array.from(subject).slice(0, 160).join(''),
    text: [
      firstName ? `Hi ${firstName},` : 'Hello,', ...paragraphs, `${label}: ${link}`,
      signIn, help,
      `Phone: ${phone}\nEmail: ${supportEmail}`, `${closing}\nThe ${company} Team`,
    ].join('\n\n'),
    html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="16"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
<tr><td style="padding:28px;background:#101322;color:#fff;text-align:center">
<img src="${html(logo)}" width="150" alt="${html(company)}" style="display:block;width:150px;height:auto;margin:0 auto 18px;border:0" />
<p style="margin:0 0 8px;font-size:14px">${html(company)}</p>
<h1 style="margin:0;font-size:24px;line-height:1.3">${html(title)}</h1></td></tr>
<tr><td style="padding:28px;line-height:1.65;font-size:15px">
<p style="margin-top:0">${html(firstName ? `Hi ${firstName},` : 'Hello,')}</p>
${paragraphs.map(p => `<p>${html(p)}</p>`).join('\n')}
<p style="margin:28px 0"><a href="${html(link)}" style="display:inline-block;padding:14px 24px;background:#ef0000;color:#fff;text-decoration:none;border-radius:9px;font-weight:bold">${html(label)}</a></p>
<p>${html(signIn)}</p><p>${html(help)}</p>
<p>Phone: <a href="tel:${html(phoneHref)}" style="color:#b91c1c">${html(phone)}</a><br />
Email: <a href="mailto:${html(supportEmail)}" style="color:#b91c1c;word-break:break-all">${html(supportEmail)}</a></p>
<p>${html(closing)}<br /><strong>The ${html(company)} Team</strong></p>
<p style="margin-bottom:0;padding-top:20px;border-top:1px solid #e5e7eb;color:#64748b;font-size:12px">If the button does not work, open:<br />
<a href="${html(link)}" style="color:#475569;word-break:break-all">${html(link)}</a></p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
