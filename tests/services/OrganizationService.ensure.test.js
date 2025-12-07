const OrganizationService = require('../../src/services/OrganizationService');
const difyApi = require('../../src/infrastructure/dify/api');
const redisCache = require('../../src/infrastructure/redis/cache');

// Мокаем зависимости
jest.mock('../../src/infrastructure/dify/api');
jest.mock('../../src/infrastructure/redis/cache');
jest.mock('../../src/infrastructure/redis/client', () => {
  const Redis = jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scanStream: jest.fn(),
    pipeline: jest.fn(() => ({
      set: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    })),
  }));
  return Redis;
});
jest.mock('../../src/config', () => ({
  dify: {
    keys: {
      admin: 'admin-key-for-test',
    },
  },
  redis: {
    host: 'localhost',
    port: 6379,
  },
}));

const config = require('../../src/config');

describe('OrganizationService - ensureAdminKb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('должен вернуть adminKbId из кэша, если база уже есть в Redis', async () => {
    const orgId = 'org-123';
    const cachedData = {
      adminKbId: 'ds-cached-123',
      historyKbId: 'ds-history-456',
    };

    redisCache.getOrgDatasets.mockResolvedValue(cachedData);

    const result = await OrganizationService.ensureAdminKb(orgId);

    expect(result).toBe('ds-cached-123');
    expect(redisCache.getOrgDatasets).toHaveBeenCalledWith(orgId);
    expect(difyApi.listDatasets).not.toHaveBeenCalled();
    expect(difyApi.createDataset).not.toHaveBeenCalled();
    expect(redisCache.setOrgDatasets).not.toHaveBeenCalled();
  });

  test('должен найти базу в Dify и сохранить в Redis, если её нет в кэше', async () => {
    const orgId = 'org-123';
    const foundDataset = {
      id: 'ds-found-789',
      name: 'KB_ADMIN_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [
        { id: 'ds-other-1', name: 'KB_ADMIN_org-other' },
        foundDataset,
        { id: 'ds-other-2', name: 'KB_HISTORY_org-123' },
      ],
      has_more: false,
    });
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureAdminKb(orgId);

    expect(result).toBe('ds-found-789');
    expect(difyApi.listDatasets).toHaveBeenCalledWith('admin-key-for-test', 1, 50);
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: 'ds-found-789',
      historyKbId: null,
    });
    expect(difyApi.createDataset).not.toHaveBeenCalled();
  });

  test('должен создать новую базу, если её нет ни в кэше, ни в Dify', async () => {
    const orgId = 'org-123';
    const newDataset = {
      id: 'ds-new-999',
      name: 'KB_ADMIN_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [
        { id: 'ds-other-1', name: 'KB_ADMIN_org-other' },
        { id: 'ds-other-2', name: 'KB_HISTORY_org-123' },
      ],
      has_more: false,
    });
    difyApi.createDataset.mockResolvedValue(newDataset);
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureAdminKb(orgId);

    expect(result).toBe('ds-new-999');
    expect(difyApi.createDataset).toHaveBeenCalledWith(
      'admin-key-for-test',
      'KB_ADMIN_org-123'
    );
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: 'ds-new-999',
      historyKbId: null,
    });
  });

  test('должен сохранить historyKbId при обновлении adminKbId', async () => {
    const orgId = 'org-123';
    const existingHistoryKbId = 'ds-history-existing';
    const newDataset = {
      id: 'ds-admin-new',
      name: 'KB_ADMIN_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValueOnce({
      adminKbId: null,
      historyKbId: existingHistoryKbId,
    });

    difyApi.listDatasets.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    difyApi.createDataset.mockResolvedValue(newDataset);
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureAdminKb(orgId);

    expect(result).toBe('ds-admin-new');
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: 'ds-admin-new',
      historyKbId: existingHistoryKbId,
    });
  });

  test('должен обрабатывать пагинацию при поиске в Dify', async () => {
    const orgId = 'org-123';
    const foundDataset = {
      id: 'ds-found-paginated',
      name: 'KB_ADMIN_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);

    // Первая страница - не нашли
    difyApi.listDatasets.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) => ({
        id: `ds-${i}`,
        name: `KB_ADMIN_org${i}`,
      })),
      has_more: true,
    });

    // Вторая страница - нашли
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [foundDataset],
      has_more: false,
    });

    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureAdminKb(orgId);

    expect(result).toBe('ds-found-paginated');
    expect(difyApi.listDatasets).toHaveBeenCalledTimes(2);
    expect(difyApi.createDataset).not.toHaveBeenCalled();
  });

  test('должен обрабатывать ошибки при создании датасета', async () => {
    const orgId = 'org-123';

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    difyApi.createDataset.mockRejectedValue(new Error('Dify API error'));

    await expect(OrganizationService.ensureAdminKb(orgId)).rejects.toThrow(
      'Dify API error'
    );
  });

  test('должен выбрасывать ошибку при отсутствии orgId', async () => {
    await expect(OrganizationService.ensureAdminKb(null)).rejects.toThrow(
      'orgId is required'
    );
    await expect(OrganizationService.ensureAdminKb(undefined)).rejects.toThrow(
      'orgId is required'
    );
  });

  test('должен выбрасывать ошибку при отсутствии admin key', async () => {
    const orgId = 'org-123';
    const originalConfig = config.dify.keys.admin;

    // Временно удаляем admin key
    delete config.dify.keys.admin;

    redisCache.getOrgDatasets.mockResolvedValue(null);

    await expect(OrganizationService.ensureAdminKb(orgId)).rejects.toThrow(
      'Dify admin key is not configured'
    );

    // Восстанавливаем
    config.dify.keys.admin = originalConfig;
  });
});

describe('OrganizationService - ensureHistoryKb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('должен вернуть historyKbId из кэша, если база уже есть в Redis', async () => {
    const orgId = 'org-123';
    const cachedData = {
      adminKbId: 'ds-admin-123',
      historyKbId: 'ds-cached-456',
    };

    redisCache.getOrgDatasets.mockResolvedValue(cachedData);

    const result = await OrganizationService.ensureHistoryKb(orgId);

    expect(result).toBe('ds-cached-456');
    expect(redisCache.getOrgDatasets).toHaveBeenCalledWith(orgId);
    expect(difyApi.listDatasets).not.toHaveBeenCalled();
    expect(difyApi.createDataset).not.toHaveBeenCalled();
    expect(redisCache.setOrgDatasets).not.toHaveBeenCalled();
  });

  test('должен найти базу в Dify и сохранить в Redis, если её нет в кэше', async () => {
    const orgId = 'org-123';
    const foundDataset = {
      id: 'ds-history-found',
      name: 'KB_HISTORY_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [
        { id: 'ds-other-1', name: 'KB_ADMIN_org-123' },
        foundDataset,
        { id: 'ds-other-2', name: 'KB_HISTORY_org-other' },
      ],
      has_more: false,
    });
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureHistoryKb(orgId);

    expect(result).toBe('ds-history-found');
    expect(difyApi.listDatasets).toHaveBeenCalledWith('admin-key-for-test', 1, 50);
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: null,
      historyKbId: 'ds-history-found',
    });
    expect(difyApi.createDataset).not.toHaveBeenCalled();
  });

  test('должен создать новую базу, если её нет ни в кэше, ни в Dify', async () => {
    const orgId = 'org-123';
    const newDataset = {
      id: 'ds-history-new',
      name: 'KB_HISTORY_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [
        { id: 'ds-other-1', name: 'KB_ADMIN_org-123' },
        { id: 'ds-other-2', name: 'KB_HISTORY_org-other' },
      ],
      has_more: false,
    });
    difyApi.createDataset.mockResolvedValue(newDataset);
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureHistoryKb(orgId);

    expect(result).toBe('ds-history-new');
    expect(difyApi.createDataset).toHaveBeenCalledWith(
      'admin-key-for-test',
      'KB_HISTORY_org-123'
    );
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: null,
      historyKbId: 'ds-history-new',
    });
  });

  test('должен сохранить adminKbId при обновлении historyKbId', async () => {
    const orgId = 'org-123';
    const existingAdminKbId = 'ds-admin-existing';
    const newDataset = {
      id: 'ds-history-new',
      name: 'KB_HISTORY_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValueOnce({
      adminKbId: existingAdminKbId,
      historyKbId: null,
    });

    difyApi.listDatasets.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    difyApi.createDataset.mockResolvedValue(newDataset);
    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureHistoryKb(orgId);

    expect(result).toBe('ds-history-new');
    expect(redisCache.setOrgDatasets).toHaveBeenCalledWith(orgId, {
      adminKbId: existingAdminKbId,
      historyKbId: 'ds-history-new',
    });
  });

  test('должен обрабатывать пагинацию при поиске в Dify', async () => {
    const orgId = 'org-123';
    const foundDataset = {
      id: 'ds-history-paginated',
      name: 'KB_HISTORY_org-123',
    };

    redisCache.getOrgDatasets.mockResolvedValue(null);

    // Первая страница - не нашли
    difyApi.listDatasets.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) => ({
        id: `ds-${i}`,
        name: `KB_HISTORY_org${i}`,
      })),
      has_more: true,
    });

    // Вторая страница - нашли
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [foundDataset],
      has_more: false,
    });

    redisCache.setOrgDatasets.mockResolvedValue(undefined);

    const result = await OrganizationService.ensureHistoryKb(orgId);

    expect(result).toBe('ds-history-paginated');
    expect(difyApi.listDatasets).toHaveBeenCalledTimes(2);
    expect(difyApi.createDataset).not.toHaveBeenCalled();
  });

  test('должен обрабатывать ошибки при создании датасета', async () => {
    const orgId = 'org-123';

    redisCache.getOrgDatasets.mockResolvedValue(null);
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    difyApi.createDataset.mockRejectedValue(new Error('Dify API error'));

    await expect(OrganizationService.ensureHistoryKb(orgId)).rejects.toThrow(
      'Dify API error'
    );
  });

  test('должен выбрасывать ошибку при отсутствии orgId', async () => {
    await expect(OrganizationService.ensureHistoryKb(null)).rejects.toThrow(
      'orgId is required'
    );
    await expect(OrganizationService.ensureHistoryKb(undefined)).rejects.toThrow(
      'orgId is required'
    );
  });
});

