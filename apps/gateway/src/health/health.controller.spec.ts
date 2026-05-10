import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('livez', () => {
    it('returns alive without touching the database', () => {
      const result = controller.livez();
      expect(result).toEqual(
        expect.objectContaining({ status: 'alive' }),
      );
      expect(typeof result.uptime).toBe('number');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('readyz', () => {
    it('returns ready when the DB round-trip succeeds', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      const result = await controller.readyz();
      expect(result).toEqual({ status: 'ready', database: 'reachable' });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('throws 503 when the DB is unreachable', async () => {
      prisma.$queryRaw.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(controller.readyz()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('surfaces the underlying error message in the 503 payload', async () => {
      prisma.$queryRaw.mockRejectedValueOnce(new Error('boom'));
      try {
        await controller.readyz();
        fail('expected ServiceUnavailableException');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const response = (err as ServiceUnavailableException).getResponse();
        expect(response).toMatchObject({
          status: 'unready',
          database: 'unreachable',
          error: 'boom',
        });
      }
    });
  });
});
