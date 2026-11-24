import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Injectable, Logger, Post, Query, Req } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Request } from 'express';
import { PrismaService } from '@/prisma/prisma.service';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const labelPattern = /^[A-Za-z0-9_-]{1,100}$/;
export type Attribution = { id: string; campaign: string; ad: string };
export function parseAttribution(value: unknown): Attribution | null {
  if (!value || typeof value !== 'object') return null;
  const { id, campaign, ad = '' } = value as Partial<Attribution>;
  return typeof id === 'string' && idPattern.test(id) &&
    typeof campaign === 'string' && (labelPattern.test(campaign) || (campaign === '' && ad === '')) &&
    typeof ad === 'string' && (ad === '' || labelPattern.test(ad))
    ? { id, campaign, ad } : null;
}
export function readAttributionHeader(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) return null;
  try { return parseAttribution(JSON.parse(value)); } catch { return null; }
}
const browserStages = { opened: 1, started: 2, submitted: 3, invalid: 3 } as const;
export function parseBrowserEvent(value: unknown) {
  const attribution = parseAttribution(value);
  if (!attribution || !value || typeof value !== 'object') return null;
  const stage = (value as { stage?: unknown }).stage;
  if (typeof stage !== 'string' || !Object.prototype.hasOwnProperty.call(browserStages, stage)) return null;
  return { ...attribution, stage: browserStages[stage as keyof typeof browserStages], errors: stage === 'invalid' ? 1 : 0 };
}
export function registrationErrorBits(e: unknown) {
  if (!(e instanceof HttpException)) return 16;
  const status = e.getStatus();
  const response = e.getResponse();
  const code = typeof response === 'object' && response !== null && 'code' in response ? response.code : null;
  if (code === 'PLATFORM_TERMS_CHANGED' || code === 'PLATFORM_TERMS_REQUIRED' || code === 'CONSENT_VERSION_CHANGED') return 4;
  if (status === 409) return 8;
  return status < 500 ? 2 : 16;
}

type DbRow = {
  campaign: string; ad: string; opened: bigint; started: bigint; submitted: bigint; completed: bigint;
  abandonedBeforeStart: bigint; abandonedBeforeSubmit: bigint; abandonedAfterSubmit: bigint; pending: bigint;
  invalidForm: bigint; rejected: bigint; termsChanged: bigint; conflict: bigint; serverError: bigint;
};

@Injectable()
export class RegistrationAnalytics {
  private readonly logger = new Logger(RegistrationAnalytics.name);
  constructor(private readonly db: PrismaService) {}

  async record(a: Attribution, stage: number, errors = 0) {
    try {
      await this.db.$executeRaw`
        INSERT INTO registration_analytics_attempts
        (id, campaign, ad, stage, errors, opened_at, activity_at)
        VALUES (${a.id}, ${a.campaign}, ${a.ad}, ${stage}, ${errors}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          activity_at = IF(campaign = ${a.campaign} AND ad = ${a.ad} AND
            (stage < ${stage} OR (errors | ${errors}) <> errors), UTC_TIMESTAMP(3), activity_at),
          errors = IF(campaign = ${a.campaign} AND ad = ${a.ad} AND stage < 4, errors | ${errors}, errors),
          stage = IF(campaign = ${a.campaign} AND ad = ${a.ad}, GREATEST(stage, ${stage}), stage)
      `;
    } catch {
      // The optional metric must never turn a successful signup into a failure.
      this.logger.warn('Could not record registration analytics.');
    }
  }

  @Cron('0 20 4 * * *', { timeZone: 'UTC' })
  async expire() {
    // Bound storage and deletion work. The report intentionally covers at most 90 days.
    try {
      await this.db.$executeRaw`DELETE FROM registration_analytics_attempts WHERE opened_at < UTC_TIMESTAMP() - INTERVAL 90 DAY ORDER BY opened_at LIMIT 20000`;
    } catch {
      this.logger.warn('Could not expire registration analytics records.');
    }
  }

  async report(days: number) {
    const since = new Date(Date.now() - days * 86400000);
    const rows = await this.db.$queryRaw<DbRow[]>`
      SELECT campaign, ad, COUNT(*) AS opened,
        COUNT(CASE WHEN stage >= 2 THEN 1 END) AS started,
        COUNT(CASE WHEN stage >= 3 THEN 1 END) AS submitted,
        COUNT(CASE WHEN stage = 4 THEN 1 END) AS completed,
        COUNT(CASE WHEN stage = 1 AND activity_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 1 END) AS abandonedBeforeStart,
        COUNT(CASE WHEN stage = 2 AND activity_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 1 END) AS abandonedBeforeSubmit,
        COUNT(CASE WHEN stage = 3 AND activity_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 1 END) AS abandonedAfterSubmit,
        COUNT(CASE WHEN stage < 4 AND activity_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 1 END) AS pending,
        COUNT(CASE WHEN (errors & 1) <> 0 THEN 1 END) AS invalidForm,
        COUNT(CASE WHEN (errors & 2) <> 0 THEN 1 END) AS rejected,
        COUNT(CASE WHEN (errors & 4) <> 0 THEN 1 END) AS termsChanged,
        COUNT(CASE WHEN (errors & 8) <> 0 THEN 1 END) AS conflict,
        COUNT(CASE WHEN (errors & 16) <> 0 THEN 1 END) AS serverError
      FROM registration_analytics_attempts WHERE opened_at >= ${since}
      GROUP BY campaign, ad ORDER BY (campaign = '') DESC, opened DESC, campaign, ad LIMIT 501
    `;
    return { days, truncated: rows.length > 500, rows: rows.slice(0, 500).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
    )) };
  }
}

@Controller('registration-analytics')
export class RegistrationAnalyticsController {
  private minute = -1;
  private total = 0;
  private readonly budgets = new Map<string, number>();
  constructor(private readonly analytics: RegistrationAnalytics) {}

  @Public()
  @Post('event')
  @HttpCode(204)
  async record(@Body() body: unknown, @Req() req: Request) {
    const event = parseBrowserEvent(body);
    if (!event) throw new BadRequestException('Invalid registration metric.');
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.total = 0;
      this.budgets.clear();
    }
    const client = req.ip || 'unknown';
    const count = this.budgets.get(client) ?? 0;
    if (this.total >= 500 || count >= 150) throw new HttpException('Too many metric requests.', 429);
    this.total++;
    this.budgets.set(client, count + 1);
    await this.analytics.record(event, event.stage, event.errors);
  }

  @Roles('admin')
  @Get('report')
  report(@Query('days') days?: string) {
    if (days !== undefined && !['7', '30', '90'].includes(days)) throw new BadRequestException('Invalid period.');
    return this.analytics.report(Number(days ?? 30));
  }
}
