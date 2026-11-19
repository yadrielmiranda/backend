import type { DealerPreferredLanguage } from '@prisma/client';

const copy = {
  English: {
    approved: 'Your dealer network application was approved.',
    rejected: 'Your dealer network application was not approved.',
    ready: 'Welcome! Your account is ready. Sign in with the credentials you chose when you applied.',
    help: 'If you have questions, contact the person or company that invited you.',
    signIn: 'Sign in',
    stop: 'Reply STOP to unsubscribe.',
  },
  Spanish: {
    approved: 'Tu solicitud para la red de dealers fue aprobada.',
    rejected: 'Tu solicitud para la red de dealers no fue aprobada.',
    ready: 'Tu cuenta ya está lista. Inicia sesión con los datos que elegiste al enviar la solicitud.',
    help: 'Si tienes preguntas, contacta a la persona o empresa que te invitó.',
    signIn: 'Iniciar sesión',
    stop: 'Responde STOP para cancelar los SMS.',
  },
} as const;

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderRegistrationResultEmail(
  language: DealerPreferredLanguage, approved: boolean, company: string, origin: string,
) {
  const words = copy[language];
  const title = approved ? words.approved : words.rejected;
  const message = approved ? words.ready : words.help;
  const link = approved ? new URL('/login', origin).href : null;
  const logo = new URL('/branding/authentic-login-logo.png', origin).href;
  return {
    subject: `${company} - ${title}`,
    text: [company, title, message, ...(link ? [`${words.signIn}: ${link}`] : [])].join('\n\n'),
    html: `<!doctype html><html lang="${language === 'Spanish' ? 'es' : 'en'}"><body style="font-family:Arial,sans-serif;color:#111827">
<main style="max-width:560px;margin:auto;padding:24px"><img src="${escapeHtml(logo)}" width="140" alt="${escapeHtml(company)}">
<h1 style="font-size:24px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
${link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(words.signIn)}</a></p>` : ''}
<p>${escapeHtml(company)}</p></main></body></html>`,
  };
}

export function renderRegistrationResultSms(language: DealerPreferredLanguage, approved: boolean, publicUrl?: string) {
  const words = copy[language];
  const parts = ['Authentic Evolution:', approved ? words.approved : words.rejected];
  if (approved) {
    let login: URL | null = null;
    if (publicUrl && URL.canParse(publicUrl)) {
      const origin = new URL(publicUrl);
      if (origin.protocol === 'https:' && !origin.username && !origin.password) login = new URL('/login', origin);
    }
    const signIn = language === 'Spanish' ? 'Inicia sesión' : 'Sign in';
    parts.push(login ? `${signIn}: ${login.href}` : language === 'Spanish' ? 'Inicia sesión en tu portal.' : 'Sign in to your portal.');
  }
  parts.push(words.stop);
  return parts.join(' ');
}
