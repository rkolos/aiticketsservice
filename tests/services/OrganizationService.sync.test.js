const OrganizationService = require('../../src/services/OrganizationService');
const difyApi = require('../../src/infrastructure/dify/api');
const redisCache = require('../../src/infrastructure/redis/cache');

// Мокаем зависимости
jest.mock('../../src/infrastructure/dify/api');
jest.mock('../../src/infrastructure/redis/cache');

describe('OrganizationService - syncCacheWithDify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('должен синхронизировать датасеты с одной страницы', async () => {
    const mockDatasets = [
      { id: 'ds-1', name: 'KB_ADMIN_org1' },
      { id: 'ds-2', name: 'KB_HISTORY_org1' },
      { id: 'ds-3', name: 'KB_ADMIN_org2' },
    ];

    difyApi.listDatasets.mockResolvedValueOnce({
      data: mockDatasets,
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.processed).toBe(3);
    expect(stats.updated).toBe(2); // 2 организации
    expect(difyApi.listDatasets).toHaveBeenCalledTimes(1);
    expect(redisCache.msetOrgDatasets).toHaveBeenCalledWith([
      { orgId: 'org1', adminKbId: 'ds-1', historyKbId: 'ds-2' },
      { orgId: 'org2', adminKbId: 'ds-3', historyKbId: null },
    ]);
  });

  test('должен обрабатывать несколько страниц с пагинацией', async () => {
    const page1Datasets = Array.from({ length: 50 }, (_, i) => ({
      id: `ds-${i + 1}`,
      name: `KB_ADMIN_org${i + 1}`,
    }));

    const page2Datasets = Array.from({ length: 30 }, (_, i) => ({
      id: `ds-${i + 51}`,
      name: `KB_ADMIN_org${i + 51}`,
    }));

    difyApi.listDatasets
      .mockResolvedValueOnce({
        data: page1Datasets,
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: page2Datasets,
        has_more: false,
      });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.processed).toBe(80);
    expect(stats.updated).toBe(80); // 80 организаций
    expect(difyApi.listDatasets).toHaveBeenCalledTimes(2);
    expect(difyApi.listDatasets).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      1,
      50
    );
    expect(difyApi.listDatasets).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      2,
      50
    );
  });

  test('должен обрабатывать пустой результат', async () => {
    difyApi.listDatasets.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.processed).toBe(0);
    expect(stats.updated).toBe(0);
    // При пустом результате msetOrgDatasets не вызывается
    expect(redisCache.msetOrgDatasets).not.toHaveBeenCalled();
  });

  test('должен корректно парсить имена датасетов', async () => {
    const mockDatasets = [
      { id: 'ds-1', name: 'KB_ADMIN_org123' },
      { id: 'ds-2', name: 'KB_HISTORY_org123' },
      { id: 'ds-3', name: 'KB_ADMIN_org456' },
      { id: 'ds-4', name: 'KB_HISTORY_org456' },
      { id: 'ds-5', name: 'OTHER_DATASET' }, // Должен быть проигнорирован
      { id: 'ds-6', name: 'KB_ADMIN_org789' },
    ];

    difyApi.listDatasets.mockResolvedValueOnce({
      data: mockDatasets,
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.processed).toBe(6);
    expect(stats.updated).toBe(3); // 3 организации (org123, org456, org789)

    expect(redisCache.msetOrgDatasets).toHaveBeenCalledWith([
      {
        orgId: 'org123',
        adminKbId: 'ds-1',
        historyKbId: 'ds-2',
      },
      {
        orgId: 'org456',
        adminKbId: 'ds-3',
        historyKbId: 'ds-4',
      },
      {
        orgId: 'org789',
        adminKbId: 'ds-6',
        historyKbId: null,
      },
    ]);
  });

  test('должен игнорировать датасеты без имени или ID', async () => {
    const mockDatasets = [
      { id: 'ds-1', name: 'KB_ADMIN_org1' },
      { id: 'ds-2' }, // Без имени - игнорируется
      { name: 'KB_ADMIN_org2' }, // Без ID - игнорируется
      { id: 'ds-4', name: 'KB_HISTORY_org1' },
    ];

    difyApi.listDatasets.mockResolvedValueOnce({
      data: mockDatasets,
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.processed).toBe(4);
    expect(stats.updated).toBe(1); // Только org1

    expect(redisCache.msetOrgDatasets).toHaveBeenCalledWith([
      {
        orgId: 'org1',
        adminKbId: 'ds-1',
        historyKbId: 'ds-4',
      },
    ]);
  });

  test('должен корректно группировать датасеты по одной организации', async () => {
    const mockDatasets = [
      { id: 'ds-1', name: 'KB_ADMIN_org1' },
      { id: 'ds-2', name: 'KB_HISTORY_org1' },
    ];

    difyApi.listDatasets.mockResolvedValueOnce({
      data: mockDatasets,
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockResolvedValue(undefined);

    const stats = await OrganizationService.syncCacheWithDify();

    expect(stats.updated).toBe(1);
    expect(redisCache.msetOrgDatasets).toHaveBeenCalledWith([
      {
        orgId: 'org1',
        adminKbId: 'ds-1',
        historyKbId: 'ds-2',
      },
    ]);
  });

  test('должен обрабатывать ошибки от Dify API', async () => {
    difyApi.listDatasets.mockRejectedValueOnce(
      new Error('Dify API error')
    );

    await expect(OrganizationService.syncCacheWithDify()).rejects.toThrow(
      'Dify API error'
    );
  });

  test('должен обрабатывать ошибки записи в Redis', async () => {
    const mockDatasets = [
      { id: 'ds-1', name: 'KB_ADMIN_org1' },
    ];

    difyApi.listDatasets.mockResolvedValueOnce({
      data: mockDatasets,
      has_more: false,
    });

    redisCache.msetOrgDatasets.mockRejectedValueOnce(
      new Error('Redis write error')
    );

    await expect(OrganizationService.syncCacheWithDify()).rejects.toThrow(
      'Redis write error'
    );
  });
});

