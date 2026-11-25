const approvalTitle = 'Your dealer network application was approved.';
const rejectionTitle = 'Your dealer network application was not approved.';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderRegistrationResultEmail(approved: boolean, company: string, origin: string) {
  const title = approved ? approvalTitle : rejectionTitle;
  const message = approved
    ? 'Welcome! Your account is ready. Sign in with the email and password you used to apply.'
    : 'If you have questions, contact the person or company that invited you.';
  const link = approved ? new URL('/login', origin).href : null;
  const logo = new URL('/branding/authentic-login-logo.png', origin).href;
  return {
    subject: `${company} - ${title}`,
    text: [company, title, message, ...(link ? [`Sign in: ${link}`] : [])].join('\n\n'),
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#111827">
<main style="max-width:560px;margin:auto;padding:24px"><img src="${escapeHtml(logo)}" width="140" alt="${escapeHtml(company)}">
<h1 style="font-size:24px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
${link ? `<p><a href="${escapeHtml(link)}">Sign in</a></p>` : ''}
<p>${escapeHtml(company)}</p></main></body></html>`,
  };
}

export function renderRegistrationResultSms(approved: boolean, publicUrl?: string) {
  const parts = ['Authentic Evolution:', approved ? approvalTitle : rejectionTitle];
  if (approved) {
    let login: URL | null = null;
    if (publicUrl && URL.canParse(publicUrl)) {
      const origin = new URL(publicUrl);
      if (origin.protocol === 'https:' && !origin.username && !origin.password) login = new URL('/login', origin);
    }
    parts.push(login ? `Sign in: ${login.href}` : 'Sign in to your portal.');
  }
  parts.push('Reply STOP to unsubscribe.');
  return parts.join(' ');
}
