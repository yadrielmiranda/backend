# Account welcome emails

New accounts enqueue one welcome email in the same database transaction that creates the account. A worker sends committed rows through the existing `NOTIFICATIONS_SMTP_*` settings, independently of SMS and password-reset mail.

Covered entry points: public client registration, administrator-created commercial/staff accounts, dealer-network accounts, and administrator-created technicians. Existing accounts are not backfilled, and editing an account does not enqueue another welcome.

Technicians have an optional, non-unique `User.contactEmail`. It can match another technician's contact address or a dealer's login email. It is never used for authentication or password recovery; technicians continue using their username. A technician created without a contact email receives no welcome email. Other accounts retain their unique login email.

## Deployment

Deploy the backend and frontend changes together through the normal Git workflow. No new dependencies are required. Email delivery requires `NODE_ENV=production`; see the local-development protection below.

Before starting the changed backend, run from the backend directory:

```sh
npx prisma migrate deploy
npx prisma generate
npm run build
```

The migration `20261116120000_account_welcome_emails` adds the nullable contact address and the empty `AccountWelcomeEmail` queue. It does not update existing account identities, enqueue old users, or send messages. Rebuild the frontend and restart both services using the existing deployment process. On Windows, stop the local backend before generating Prisma if its engine DLL is locked.

The backend uses `PUBLIC_FRONTEND_URL` to generate the portal and logo links. Production requires HTTPS. The existing notification sender should be `notifications@authenticevolutionco.com`, with `NOTIFICATIONS_SMTP_REPLY_TO=sales@authenticevolutionco.com`. The welcome template also includes the support telephone, +1 (786) 999-4224. Passwords are never included.

## Delivery states

The queue is keyed by account ID, not email, so distinct accounts can each receive their own welcome at a shared address. The worker checks for pending messages every ten seconds and claims each message before sending. Inactive/deleted accounts or changed destination addresses are skipped.

`ACCEPTED` means the mail provider accepted the message, not that it reached the inbox. An explicit temporary SMTP rejection may be retried up to three attempts. Ambiguous connection failures or interrupted sends become `UNKNOWN` and are not automatically repeated. Pending messages older than 24 hours expire. Missing notification configuration leaves pending messages untouched until configuration is available.

Automated tests use mocked mail delivery. Creating a real new account after deployment can send a real welcome email; use an address controlled by the tester for a delivery check.

## Local development and restored backups

All email delivery is blocked unless `NODE_ENV=production`. An unset environment, development, test, or any other environment cannot send mail, even when production SMTP credentials or pending outboxes are present.

Keep the following in the local backend `.env` as an additional explicit block:

```dotenv
EMAIL_DELIVERY_ENABLED=false
```

This setting also blocks mail if a local process is accidentally started with `NODE_ENV=production`. It belongs to the local environment file, not the database, so restoring a database backup does not enable delivery. Restart the backend after changing the environment file.

The protection covers welcome emails, notification emails, material-purchase receipts, estimate-sharing emails, and password recovery. Disabled workers do not read, claim, expire, or update restored queue rows. Explicit email actions report that sending is unavailable; they do not pretend a message was sent. No recipient addresses, passwords, or recovery links are printed as substitutes for sending.

On the VPS, keep `NODE_ENV=production` and leave `EMAIL_DELIVERY_ENABLED` unset (existing production behavior), or set it to `true`. `false` or an unrecognized value blocks delivery in production as well. Setting it to `true` never enables delivery outside production. Do not copy the local `.env` over the VPS environment.

This protection needs no migration. The earlier `20261116120000_account_welcome_emails` migration is still necessary to test creation of new accounts against a database restored from before that feature. Disabling the worker does not add the missing table or contact-email column. SMS behavior is unchanged by this email-only protection.
