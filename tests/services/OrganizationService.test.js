const OrganizationService = require('../../src/services/OrganizationService');
const { KbNotFoundError } = require('../../src/core/errors');
const redisCache = require('../../src/infrastructure/redis/cache');

// Мокаем redisCache
jest.mock('../../src/infrastructure/redis/cache', () => ({
  getOrgDatasets: jest.fn(),
  deleteOrgDatasets: jest.fn(),
}));

describe('OrganizationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getKbIdsOrThrow', () => {
    test('должен возвращать объект с adminKbId и historyKbId при наличии данных', async () => {
      const orgId = 'org-123';
      const mockData = {
        adminKbId: 'ds-123',
        historyKbId: 'ds-456',
      };

      redisCache.getOrgDatasets.mockResolvedValue(mockData);

      const result = await OrganizationService.getKbIdsOrThrow(orgId);

      expect(result).toEqual(mockData);
      expect(result.adminKbId).toBe('ds-123');
      expect(result.historyKbId).toBe('ds-456');
      expect(redisCache.getOrgDatasets).toHaveBeenCalledWith(orgId);
    });

    test('должен выбрасывать KbNotFoundError при отсутствии данных', async () => {
      const orgId = 'org-123';

      redisCache.getOrgDatasets.mockResolvedValue(null);

      await expect(OrganizationService.getKbIdsOrThrow(orgId)).rejects.toThrow(
        KbNotFoundError
      );
      expect(redisCache.getOrgDatasets).toHaveBeenCalledWith(orgId);
    });

    test('должен выбрасывать KbNotFoundError при undefined', async () => {
      const orgId = 'org-123';

      redisCache.getOrgDatasets.mockResolvedValue(undefined);

      await expect(OrganizationService.getKbIdsOrThrow(orgId)).rejects.toThrow(
        KbNotFoundError
      );
    });

    test('должен выбрасывать KbNotFoundError при отсутствии adminKbId', async () => {
      const orgId = 'org-123';
      const mockData = {
        historyKbId: 'ds-456',
      };

      redisCache.getOrgDatasets.mockResolvedValue(mockData);

      await expect(OrganizationService.getKbIdsOrThrow(orgId)).rejects.toThrow(
        KbNotFoundError
      );
    });

    test('должен выбрасывать KbNotFoundError при отсутствии historyKbId', async () => {
      const orgId = 'org-123';
      const mockData = {
        adminKbId: 'ds-123',
      };

      redisCache.getOrgDatasets.mockResolvedValue(mockData);

      await expect(OrganizationService.getKbIdsOrThrow(orgId)).rejects.toThrow(
        KbNotFoundError
      );
    });

    test('должен выбрасывать KbNotFoundError при пустых строках', async () => {
      const orgId = 'org-123';
      const mockData = {
        adminKbId: '',
        historyKbId: 'ds-456',
      };

      redisCache.getOrgDatasets.mockResolvedValue(mockData);

      await expect(OrganizationService.getKbIdsOrThrow(orgId)).rejects.toThrow(
        KbNotFoundError
      );
    });

    test('должен выбрасывать KbNotFoundError при пустом orgId', async () => {
      await expect(OrganizationService.getKbIdsOrThrow(null)).rejects.toThrow(
        KbNotFoundError
      );

      await expect(OrganizationService.getKbIdsOrThrow(undefined)).rejects.toThrow(
        KbNotFoundError
      );
    });
  });

  describe('invalidateOrgCache', () => {
    test('должен успешно инвалидировать кэш', async () => {
      const orgId = 'org-123';
      const reason = 'stale_cache';

      redisCache.deleteOrgDatasets.mockResolvedValue(true);

      const result = await OrganizationService.invalidateOrgCache(orgId, reason);

      expect(result).toBe(true);
      expect(redisCache.deleteOrgDatasets).toHaveBeenCalledWith(orgId);
    });

    test('должен использовать дефолтный reason при отсутствии', async () => {
      const orgId = 'org-123';

      redisCache.deleteOrgDatasets.mockResolvedValue(true);

      const result = await OrganizationService.invalidateOrgCache(orgId);

      expect(result).toBe(true);
      expect(redisCache.deleteOrgDatasets).toHaveBeenCalledWith(orgId);
    });

    test('должен обрабатывать ошибки при удалении', async () => {
      const orgId = 'org-123';

      redisCache.deleteOrgDatasets.mockRejectedValue(new Error('Redis error'));

      // Не должно выбрасывать ошибку
      const result = await OrganizationService.invalidateOrgCache(orgId);

      expect(result).toBe(false);
    });

    test('должен возвращать false при отсутствии orgId', async () => {
      const result1 = await OrganizationService.invalidateOrgCache(null);
      const result2 = await OrganizationService.invalidateOrgCache(undefined);
      const result3 = await OrganizationService.invalidateOrgCache('');

      expect(result1).toBe(false);
      expect(result2).toBe(false);
      expect(result3).toBe(false);
      expect(redisCache.deleteOrgDatasets).not.toHaveBeenCalled();
    });

    test('должен обрабатывать разные причины инвалидации', async () => {
      const orgId = 'org-123';

      redisCache.deleteOrgDatasets.mockResolvedValue(true);

      await OrganizationService.invalidateOrgCache(orgId, 'manual_invalidation');
      await OrganizationService.invalidateOrgCache(orgId, 'dataset_deleted');
      await OrganizationService.invalidateOrgCache(orgId, 'migration');

      expect(redisCache.deleteOrgDatasets).toHaveBeenCalledTimes(3);
    });
  });
});

