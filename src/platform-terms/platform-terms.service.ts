import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  InternalServerErrorException, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@/auth/types/auth-user.type';
import { PlatformTermsVersion } from '@prisma/client';
import { TERMS_CONTENT_LIMIT, validateTermsContent } from './platform-terms-content';
import {
  lockCurrentPlatformTerms, needsPlatformTerms, PLATFORM_TERMS_CONSENT, platformTermsInfo,
  requireCurrentAcceptance, savePlatformTermsAcceptance,
} from './platform-terms.policy';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

@Injectable()
export class PlatformTermsService {
  constructor(private readonly prisma: PrismaService) {}

  private async currentVersion() {
    const state = await this.prisma.platformTermsState.findUniqueOrThrow({
      where: { id: 1 }, include: { currentVersion: true },
    });
    return state.currentVersion;
  }

  async current() {
    return platformTermsInfo(await this.currentVersion());
  }

  async status(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId }, select: { dealerMode: true, role: { select: { name: true } } },
    });
    const applies = needsPlatformTerms(user);
    if (!applies) return { current: null, applies: false, required: false, acceptedAt: null };
    const current = await this.currentVersion();
    const acceptance = current ? await this.prisma.platformTermsAcceptance.findUnique({
      where: { userId_versionId: { userId, versionId: current.id } },
    }) : null;
    return {
      current: platformTermsInfo(current),
      applies,
      required: Boolean(applies && current && !acceptance),
      acceptedAt: acceptance?.acceptedAt ?? null,
    };
  }

  async assertAccepted(userId: number) {
    const status = await this.status(userId);
    if (status.required) throw new ForbiddenException({
      code: 'PLATFORM_TERMS_REQUIRED',
      message: 'Read and accept the current Terms and Conditions to continue.',
      versionId: status.current!.id,
    });
  }

  async accept(userId: number, accepted: unknown, versionId: number) {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCurrentPlatformTerms(tx);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId }, select: { dealerMode: true, role: { select: { name: true } } },
      });
      if (!needsPlatformTerms(user))
        throw new BadRequestException('Your account does not require platform terms acceptance.');
      if (!current) throw new BadRequestException('No Terms and Conditions have been published.');
      requireCurrentAcceptance(current, accepted, versionId);
      // No se registra una aceptación si el documento guardado ya no está disponible.
      this.textContent(current);
      const acceptance = await savePlatformTermsAcceptance(tx, userId, current.id, 'ACCOUNT');
      return { current: platformTermsInfo(current), applies: true, required: false, acceptedAt: acceptance.acceptedAt };
    });
  }

  async myHistory(userId: number) {
    const records = await this.prisma.platformTermsAcceptance.findMany({
      where: { userId }, include: { version: true }, orderBy: { acceptedAt: 'desc' },
    });
    return records.map((record) => ({
      version: platformTermsInfo(record.version), acceptedAt: record.acceptedAt,
    }));
  }

  async administration(actor: AuthUser) {
    this.assertAdmin(actor);
    const [current, versions] = await Promise.all([
      this.current(),
      this.prisma.platformTermsVersion.findMany({
        orderBy: { id: 'desc' }, include: { _count: { select: { acceptances: true } } },
      }),
    ]);
    return {
      current,
      versions: versions.map((version) => ({
        ...platformTermsInfo(version), acceptanceCount: version._count.acceptances,
      })),
    };
  }

  private assertAdmin(actor: AuthUser) {
    if (actor?.role?.name !== 'admin') throw new ForbiddenException('Only administrators can publish platform terms.');
  }

  private textContent(version: PlatformTermsVersion) {
    if (!version.content?.trim() || hash(version.content) !== version.sourceHash)
      throw new InternalServerErrorException('The terms document is unavailable. Please contact support.');
    return version.content;
  }

  async document(versionId: number) {
    // La lectura pública solo permite el texto vigente; el historial queda en administración.
    const version = await this.currentVersion();
    if (!version || version.id !== versionId) throw new NotFoundException('Terms and Conditions not found.');
    return { version: platformTermsInfo(version), content: this.textContent(version) };
  }

  async administrationDocument(actor: AuthUser, versionId: number) {
    this.assertAdmin(actor);
    const version = await this.prisma.platformTermsVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('Terms and Conditions not found.');
    return {
      version: platformTermsInfo(version),
      content: this.textContent(version),
    };
  }

  async publishText(actor: AuthUser, input: unknown, expectedCurrentId: number) {
    this.assertAdmin(actor);
    if (typeof input !== 'string' || input.length > TERMS_CONTENT_LIMIT || !input.trim())
      throw new BadRequestException('The terms document is empty or too large. Shorten it before publishing.');
    if (!Number.isInteger(expectedCurrentId) || expectedCurrentId < 0)
      throw new BadRequestException('Review the current terms before publishing.');
    // Solo se normalizan saltos de línea y espacios exteriores; no se reescribe el texto.
    const content = input.replace(/\r\n?/g, '\n').trim();
    validateTermsContent(content);
    const sourceHash = hash(content);
    const saved = await this.prisma.$transaction(async (tx) => {
      const current = await lockCurrentPlatformTerms(tx);
      if ((current?.id ?? 0) !== expectedCurrentId)
        throw new ConflictException('Another version was published. Refresh the page before publishing.');
      if (current && current.sourceHash === sourceHash)
        return { version: current, changed: false };
      const version = await tx.platformTermsVersion.create({ data: {
        content, sourceHash, originalName: 'Terms and Conditions',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        consentText: PLATFORM_TERMS_CONSENT, publishedById: actor.id,
      } });
      await tx.platformTermsState.update({ where: { id: 1 }, data: { currentVersionId: version.id } });
      return { version, changed: true };
    });
    return { current: platformTermsInfo(saved.version), changed: saved.changed };
  }

}
