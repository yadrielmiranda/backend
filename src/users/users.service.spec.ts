import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { UsersModule } from './users.module';
import { UsersService } from './users.service';

describe('UsersService', () => {
  it('resolves the account creation dependencies in UsersModule', async () => {
    const module = await Test.createTestingModule({ imports: [UsersModule] })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(ConfigService).useValue({ get: (key: string) => key === 'JWT_SECRET_KEY' ? 'test-only-secret' : undefined })
      .compile();
    try {
      expect(module.get(UsersService)).toBeInstanceOf(UsersService);
    } finally {
      await module.close();
    }
  });
});
