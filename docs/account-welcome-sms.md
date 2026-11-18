# Account welcome SMS

Only new accounts created with valid service SMS consent are eligible. Promotional consent alone does not authorize a welcome SMS. Accounts created without service consent are not queued later when they sign in, edit their profile, opt in or reply START. No existing accounts are backfilled. The welcome email content and worker are unchanged.

The message is:

> Authentic Evolution: Welcome, Yadriel! Your account is ready. Access the portal to get started. Reply STOP to unsubscribe.

The first name is normalized for GSM-7 and limited to fit 160 septets, including the company and STOP instruction. Supported accents are preserved. Unsupported accents/punctuation are normalized; names that cannot be represented use the approved generic `Welcome!` greeting. No name or credential is added to logs.

`AccountWelcomeSms` is a separate outbox keyed by account ID. It does not add a portal bell notification or a second email. Creation and enqueueing share a transaction; provider delivery only runs after commit. The worker rechecks account activity, phone, consent timestamp/evidence and STOP before sending. It preserves the existing SMS transport's explicit rate-limit retries and stops on uncertain outcomes to avoid blind resends. Pending messages expire after 24 hours.

## Deployment

Backend only; no new dependencies or mandatory environment variables. Apply `20261118120000_account_welcome_sms` using the normal deployment sequence before starting the updated backend:

```sh
npx prisma migrate deploy
npx prisma generate
npm run build
```

The migration only creates an empty table and does not send any messages. SMS requires `NODE_ENV=production` and the existing Twilio settings. `SMS_DELIVERY_ENABLED=false` blocks production too; unset or `true` preserves enabled production behavior. Outside production no welcome SMS is queued and workers do not read, claim or alter restored rows, even with production credentials and `SMS_DELIVERY_ENABLED=true`.

Tests use fake storage and mocked delivery. No application startup or real Twilio sends are needed to validate this feature.
