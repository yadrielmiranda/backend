import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isValidUsername, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_VALIDATION_MESSAGE } from '@/common/username-policy';

export function clientUsernameBase(firstName: string, lastName: string): string {
  const words = [firstName, lastName].join(' ').normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-z0-9]+/gi) ?? [];
  const name = words.map(part => part[0].toUpperCase() + part.slice(1)).join('').replace(/^[0-9]+/, '') || 'Client';
  return (name.length < USERNAME_MIN_LENGTH ? name + 'User' : name).slice(0, USERNAME_MAX_LENGTH);
}

export function usernameTaken() {
  return new ConflictException({ code: 'USERNAME_TAKEN', field: 'username', message: 'That username is already in use. Choose another one.' });
}

function duplicateField(error: unknown): string | undefined {
  const dbError = error as { code?: string; meta?: { target?: string | string[] } };
  if (dbError?.code !== 'P2002') return;
  // Prisma/MySQL supplies the index name; other connectors supply an array of fields.
  const target = String(dbError.meta?.target ?? '').toLowerCase().split(/[^a-z0-9]+/);
  return ['username', 'email', 'phone'].find(field => target.includes(field));
}

export function identityConflict(error: unknown) {
  switch (duplicateField(error)) {
    case 'username': return usernameTaken();
    case 'email': return new ConflictException({ code: 'EMAIL_TAKEN', field: 'email', message: 'That email is already in use.' });
    case 'phone': return new ConflictException({ code: 'PHONE_TAKEN', field: 'phone', message: 'That phone number is already in use.' });
  }
}

export async function assertUsernameNotReserved(tx: Prisma.TransactionClient, username: string) {
  if (!isValidUsername(username)) throw new BadRequestException(USERNAME_VALIDATION_MESSAGE);
  const chosen = username.trim();
  if (await tx.dealerRegistrationRequest.findUnique({ where: { username: chosen }, select: { id: true } })) throw usernameTaken();
  return chosen;
}

export async function createWithClientUsername<T>(
  tx: Prisma.TransactionClient,
  input: { username?: string; firstName: string; lastName: string },
  create: (username: string) => Promise<T>,
): Promise<T> {
  if (input.username !== undefined) {
    return create(await assertUsernameNotReserved(tx, input.username));
  }

  const base = clientUsernameBase(input.firstName, input.lastName);
  const batchSize = 32;
  for (let offset = 1; ; offset += batchSize) {
    const candidates = Array.from({ length: batchSize }, (_, index) => {
      const suffix = offset + index === 1 ? '' : String(offset + index);
      return base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
    });
    const filter = { where: { username: { in: candidates } }, select: { username: true } };
    const accounts = await tx.user.findMany(filter);
    const pending = await tx.dealerRegistrationRequest.findMany(filter);
    const occupied = new Set([...accounts, ...pending].map(({ username }) => username.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()));
    for (const candidate of candidates) {
      if (occupied.has(candidate.toLowerCase())) continue;
      try {
        return await create(candidate);
      } catch (error) {
        // A writer outside this transaction can claim a candidate after the lookup.
        if (duplicateField(error) !== 'username') throw error;
      }
    }
  }
}
