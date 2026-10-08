<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Referral rewards and manual ACH withdrawals

Apply the additive `20261008180000_referral_rewards_ach` and `20261009100000_referral_role_defaults` Prisma migrations before deploying the referral code, and regenerate the Prisma client. These migrations do not backfill referrals, change existing estimates, or alter customer payments. The defaults migration preserves deliberately saved individual arrangements as exceptions and enables previously untouched profiles to inherit their role. Set `REFERRAL_BANK_ENCRYPTION_KEY` in the backend secret configuration to a cryptographically random 32-byte key encoded as canonical base64; see `referrals.env.example`. Keep the key backed up separately from the database. Bank saving and revealing fail closed if the key is unavailable. Rotating the key requires re-encrypting both saved accounts and frozen payout destinations; replacing the key alone makes them unreadable.

The admin configures **Default rewards by role** under **Settings → Referral rewards** for clients, distributors, internal subdealers, external subdealers, root external dealers and root internal dealers. Percentages start at zero until the admin sets them. Root external dealers use the difference from their own material price. Root internal dealers can use either a percentage or their assigned earnings plan. Eligible current and newly created accounts automatically inherit their category without per-account setup. An optional individual exception takes priority; **Use role defaults** removes it. A later role change that makes an exception's mode incompatible uses the new role's default for future orders. Formula details, percentages, base prices and configuration warnings are admin-only; public referral responses contain no reward terms.

Each eligible user can create a link and downloadable SVG QR under **My referrals** without a bank account or an assigned dealer earnings plan. An explicitly disabled individual link remains disabled. A valid referral link enables client registration; ordinary registration keeps its existing availability setting. Attribution is permanent, direct only, and separate from the commercial dealer hierarchy. It grants no access to another user's estimates or orders. Missing active dealer plans are flagged in the admin user list. If an order arrives before the plan is assigned, it records frozen missing-plan terms and remains pending review; it is never silently dropped, paid at a guessed rate, or retroactively replaced when a plan is later assigned. Configure active plans before directing referred sales to those accounts.

Reward conditions are copied when a new client order is created, within that order's transaction. Existing orders are never backfilled. Disabling a profile stops new links/attributions/rewards but does not erase previous rewards or withdrawals. Changes to the account's percentage, markup or plan affect future orders only. The saved dealer price basis is **saved unit app base × (1 + saved dealer markup)**, rounded per unit before multiplying quantity. This avoids recalculating historical purchases using a changed catalog; it uses the persisted cent-rounded unit base rather than unavailable historical intermediate precision.

Rewards apply only to net material sales, after material discounts and approved material principal reductions. Taxes, installation, delivery and processing surcharges are excluded. The full material obligation must be covered on a confirmed order before rewards become available. Installment components, deposit credits and material revisions follow the existing payment ledger. Unresolved refunds, ambiguous allocations, pending material revisions, and missing costs required by a real-profit plan hold availability. Material reductions and refunds reconcile the reward instead of awarding it again. A reversal after withdrawal creates an adjustment balance that future earnings must cover. Reconciliation occurs when a referral dashboard or payout action is opened; the admin's aggregate earnings summary is identified as cached. Payout decisions always recheck the underlying orders under transaction locks.

Withdrawals use US checking or savings accounts, ACH and USD only. The user requests an amount and that amount is reserved atomically. Request IDs make retries idempotent. Changing bank details affects future requests; each existing withdrawal retains its encrypted original destination. Bank details use AES-256-GCM with separate authenticated contexts for saved accounts and payout snapshots. Ordinary responses return masked account details only. An administrator must claim a withdrawal before revealing its destination; reveals are audited without recording bank numbers. Only that administrator can finish the claimed transfer, preventing two admins from processing the same request independently.

For each withdrawal, the administrator starts processing, sends the full amount through the company's bank, then records the completed transfer reference, actual date, optional receipt reference and company bank fee. **No endpoint in this version initiates an ACH transfer.** Authentic pays fees separately; fees never reduce the member's withdrawal. A requested withdrawal can be canceled or declined. A processing withdrawal can release its reservation only after its administrator explicitly confirms that no funds were sent. Paid records cannot be edited or canceled through this workflow. Do not release a reservation while a bank transfer's outcome is unknown.

If the assigned administrator cannot finish a processing record, another administrator can use **Record verified bank outcome**. This action requires the original claim ID, an explanation and explicit bank verification. Recording an already-sent transfer additionally requires its receipt reference; releasing an unsent reservation requires confirmation that no funds were sent and no transfer is pending. Recovery does not reveal bank details, reassign the transfer, or initiate another payment. Its actor and original assignee are recorded in the audit log.

The immutable reward adjustment ledger, payout state machine, request idempotency and frozen destinations can support a future automated payout provider. Provider callbacks must use the same reservation and completion transitions and record their external transfer IDs; customer payment collection remains separate.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
