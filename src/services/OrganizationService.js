const redisCache = require('../infrastructure/redis/cache');
const logger = require('../utils/logger');
const { KbNotFoundError } = require('../core/errors');
const difyApi = require('../infrastructure/dify/api');
const config = require('../config');
const { HYBRID_RETRIEVAL_CONFIG } = require('../core/constants');

/**
 * Сервис для управления данными организаций и базами знаний
 */
class OrganizationService {
  /**
   * Получить ID баз знаний для организации из Redis (Strict Read)
   * Выбрасывает ошибку, если данных нет
   * @param {string} orgId - ID организации
   * @returns {Promise<{adminKbId: string, historyKbId: string}>} Объект с ID баз знаний
   * @throws {KbNotFoundError} Если база знаний не найдена в кэше
   */
  async getKbIdsOrThrow(orgId) {
    if (!orgId) {
      throw new KbNotFoundError(orgId || 'unknown');
    }

    // Запрос данных из Redis
    const cachedData = await redisCache.getOrgDatasets(orgId);

    // Проверка наличия данных
    if (!cachedData || cachedData === null || cachedData === undefined) {
      logger.warn('Knowledge base not found in cache', { orgId });
      throw new KbNotFoundError(orgId);
    }

    // Проверка наличия обязательных полей
    if (!cachedData.adminKbId || !cachedData.historyKbId) {
      logger.warn('Incomplete knowledge base data in cache', {
        orgId,
        hasAdminKbId: !!cachedData.adminKbId,
        hasHistoryKbId: !!cachedData.historyKbId,
      });
      throw new KbNotFoundError(orgId);
    }

    // Возврат результата
    return {
      adminKbId: cachedData.adminKbId,
      historyKbId: cachedData.historyKbId,
    };
  }

  /**
   * Инвалидация кэша организации (Stale Cache Strategy)
   * Удаляет данные из Redis при обнаружении несоответствия между Redis и Dify
   * @param {string} orgId - ID организации
   * @param {string} reason - Причина инвалидации (по умолчанию 'stale_cache')
   * @returns {Promise<boolean>} Результат удаления
   */
  async invalidateOrgCache(orgId, reason = 'stale_cache') {
    if (!orgId) {
      logger.warn('Invalid orgId for cache invalidation', { orgId });
      return false;
    }

    try {
      // Удаление ключа организации из Redis
      await redisCache.deleteOrgDatasets(orgId);

      // Логирование события инвалидации
      logger.warn('Cache invalidated for org', {
        orgId,
        reason,
      });

      return true;
    } catch (error) {
      logger.error('Error during cache invalidation', {
        orgId,
        reason,
        error: error.message,
      });
      // Не выбрасываем ошибку, так как инвалидация - это "мягкая" операция
      return false;
    }
  }

  /**
   * Синхронизация кэша с состоянием Dify (Cache Warming)
   * Получает все датасеты из Dify и сохраняет их в Redis
   * @returns {Promise<Object>} Статистика синхронизации { processed, updated }
   */
  async syncCacheWithDify() {
    logger.info('Cache warming started...');

    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    // Пагинация для получения всех датасетов
    let page = 1;
    const limit = config.dify.pagination?.listDatasetsPageLimit || 50; // Размер страницы из конфига
    let allDatasets = [];
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await difyApi.listDatasets(adminKey, page, limit);

        if (response.data && Array.isArray(response.data)) {
          allDatasets.push(...response.data);

          // Проверяем, есть ли еще страницы
          // Если получили меньше limit элементов или has_more = false, значит страниц больше нет
          hasMore =
            response.data.length === limit &&
            response.has_more !== false;
        } else {
          // Если структура ответа неожиданная, прекращаем цикл
          hasMore = false;
        }

        page++;
      } catch (error) {
        logger.error('Error fetching datasets from Dify during cache warming', {
          page,
          error: error.message,
        });
        throw error;
      }
    }

    logger.debug('Total datasets fetched from Dify', {
      count: allDatasets.length,
    });

    // Парсинг имен датасетов и группировка по orgId
    const orgMap = {};

    for (const dataset of allDatasets) {
      if (!dataset.name || !dataset.id) {
        continue;
      }

      // Парсинг паттерна KB_ADMIN_*
      const adminMatch = dataset.name.match(/^KB_ADMIN_(.+)$/);
      if (adminMatch) {
        const orgId = adminMatch[1];
        if (!orgMap[orgId]) {
          orgMap[orgId] = {};
        }
        orgMap[orgId].adminKbId = dataset.id;
      }

      // Парсинг паттерна KB_HISTORY_*
      const historyMatch = dataset.name.match(/^KB_HISTORY_(.+)$/);
      if (historyMatch) {
        const orgId = historyMatch[1];
        if (!orgMap[orgId]) {
          orgMap[orgId] = {};
        }
        orgMap[orgId].historyKbId = dataset.id;
      }
      // "Чужие" датасеты игнорируются
    }

    // Подготовка данных для массовой записи
    const mappings = [];
    for (const [orgId, data] of Object.entries(orgMap)) {
      mappings.push({
        orgId,
        adminKbId: data.adminKbId || null,
        historyKbId: data.historyKbId || null,
      });
    }

    // Массовая запись в Redis
    if (mappings.length > 0) {
      try {
        await redisCache.msetOrgDatasets(mappings);
      } catch (error) {
        logger.error('Error writing to Redis during cache warming', {
          error: error.message,
        });
        throw error;
      }
    }

    // Статистика
    const stats = {
      processed: allDatasets.length,
      updated: mappings.length,
    };

    logger.info('Cache warming completed', stats);

    return stats;
  }

  /**
   * Убедиться, что у датасета настроен Hybrid Search
   * @param {string} datasetId - ID датасета
   * @param {Object} retrievalModel - Опциональная конфигурация поиска (по умолчанию используется HYBRID_RETRIEVAL_CONFIG)
   * @returns {Promise<boolean>} true если настройки применены успешно, false если Rerank модель не настроена
   */
  async ensureDatasetRetrievalSettings(datasetId, retrievalModel) {
    if (!datasetId) {
      logger.warn('ensureDatasetRetrievalSettings: datasetId is required');
      return false;
    }

    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      logger.warn('ensureDatasetRetrievalSettings: Dify admin key is not configured');
      return false;
    }

    try {
      const configToApply = retrievalModel || HYBRID_RETRIEVAL_CONFIG;
      const result = await difyApi.updateDatasetRetrievalSettings(adminKey, datasetId, configToApply);
      
      if (result.success === false) {
        // Логируем все типы ошибок с деталями
        logger.error('ensureDatasetRetrievalSettings: Failed to enable Hybrid Search', {
          datasetId,
          error: result.error,
          reason: result.reason,
          statusCode: result.statusCode,
        });
        return false;
      }

      logger.info('ensureDatasetRetrievalSettings: Hybrid Search enabled', {
        datasetId,
      });
      return true;
    } catch (error) {
      logger.error('ensureDatasetRetrievalSettings: error updating retrieval settings', {
        datasetId,
        error: error.message,
      });
      // Не выбрасываем ошибку, так как это не критично для работы системы
      return false;
    }
  }

  /**
   * Lazy Loading для базы файлов (Admin KB)
   * Гарантирует существование базы знаний для организации, создавая её при необходимости
   * Алгоритм: Cache First -> Dify Search -> Lazy Create
   * @param {string} orgId - ID организации
   * @returns {Promise<string>} ID базы знаний (adminKbId)
   */
  async ensureAdminKb(orgId) {
    if (!orgId) {
      throw new Error('orgId is required');
    }

    logger.debug('ensureAdminKb: checking cache', { orgId });

    // 1. Check Cache (Cache First)
    const cachedData = await redisCache.getOrgDatasets(orgId);
    if (cachedData && cachedData.adminKbId) {
      logger.debug('ensureAdminKb: found in cache', {
        orgId,
        adminKbId: cachedData.adminKbId,
      });
      return cachedData.adminKbId;
    }

    logger.debug('ensureAdminKb: not in cache, checking Dify', { orgId });

    // 2. Check Dify (Failover)
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    const expectedName = `KB_ADMIN_${orgId}`;
    let foundDataset = null;
    let page = 1;
    const limit = 50;
    let hasMore = true;

    while (hasMore && !foundDataset) {
      try {
        const response = await difyApi.listDatasets(adminKey, page, limit);

        if (response.data && Array.isArray(response.data)) {
          // Поиск датасета с нужным именем
          foundDataset = response.data.find(
            (dataset) => dataset.name === expectedName
          );

          hasMore =
            response.data.length === limit &&
            response.has_more !== false &&
            !foundDataset;
        } else {
          hasMore = false;
        }

        page++;
      } catch (error) {
        logger.error('ensureAdminKb: error fetching datasets from Dify', {
          orgId,
          error: error.message,
        });
        throw error;
      }
    }

    let adminKbId;

    if (foundDataset) {
      // Датасет найден в Dify
      adminKbId = foundDataset.id;
      logger.info('ensureAdminKb: found in Dify', {
        orgId,
        adminKbId,
      });
    } else {
      // 3. Create (Lazy Create)
      logger.info('ensureAdminKb: creating new dataset', { orgId });

      try {
        // ВАЖНО: Больше не нужно вызывать updateDatasetRetrievalSettings отдельно!
        // Мы передаем HYBRID_RETRIEVAL_CONFIG сразу при создании (он по умолчанию в api.js, но можно передать явно)
        const newDataset = await difyApi.createDataset(adminKey, expectedName);
        adminKbId = newDataset.id;

        logger.info('ensureAdminKb: created new dataset with Hybrid Search & Rerank', {
          orgId,
          adminKbId,
        });
      } catch (error) {
        logger.error('ensureAdminKb: error creating dataset', {
          orgId,
          error: error.message,
        });
        throw error;
      }
    }

    // 4. Update Cache
    // Сохраняем adminKbId, не затирая существующий historyKbId
    const existingHistoryKbId =
      cachedData && cachedData.historyKbId ? cachedData.historyKbId : null;

    try {
      await redisCache.setOrgDatasets(orgId, {
        adminKbId,
        historyKbId: existingHistoryKbId,
      });

      logger.debug('ensureAdminKb: cache updated', {
        orgId,
        adminKbId,
        historyKbId: existingHistoryKbId,
      });
    } catch (error) {
      logger.error('ensureAdminKb: error updating cache', {
        orgId,
        error: error.message,
      });
      // Не выбрасываем ошибку, так как база уже создана/найдена
    }

    return adminKbId;
  }

  /**
   * Lazy Loading для базы истории (History KB)
   * Гарантирует существование базы знаний для организации, создавая её при необходимости
   * Алгоритм: Cache First -> Dify Search -> Lazy Create
   * @param {string} orgId - ID организации
   * @returns {Promise<string>} ID базы знаний (historyKbId)
   */
  async ensureHistoryKb(orgId) {
    if (!orgId) {
      throw new Error('orgId is required');
    }

    logger.debug('ensureHistoryKb: checking cache', { orgId });

    // 1. Check Cache (Cache First)
    const cachedData = await redisCache.getOrgDatasets(orgId);
    if (cachedData && cachedData.historyKbId) {
      logger.debug('ensureHistoryKb: found in cache', {
        orgId,
        historyKbId: cachedData.historyKbId,
      });
      return cachedData.historyKbId;
    }

    logger.debug('ensureHistoryKb: not in cache, checking Dify', { orgId });

    // 2. Check Dify (Failover)
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    const expectedName = `KB_HISTORY_${orgId}`;
    let foundDataset = null;
    let page = 1;
    const limit = 50;
    let hasMore = true;

    while (hasMore && !foundDataset) {
      try {
        const response = await difyApi.listDatasets(adminKey, page, limit);

        if (response.data && Array.isArray(response.data)) {
          // Поиск датасета с нужным именем
          foundDataset = response.data.find(
            (dataset) => dataset.name === expectedName
          );

          hasMore =
            response.data.length === limit &&
            response.has_more !== false &&
            !foundDataset;
        } else {
          hasMore = false;
        }

        page++;
      } catch (error) {
        logger.error('ensureHistoryKb: error fetching datasets from Dify', {
          orgId,
          error: error.message,
        });
        throw error;
      }
    }

    let historyKbId;

    if (foundDataset) {
      // Датасет найден в Dify
      historyKbId = foundDataset.id;
      logger.info('ensureHistoryKb: found in Dify', {
        orgId,
        historyKbId,
      });
    } else {
      // 3. Create (Lazy Create)
      logger.info('ensureHistoryKb: creating new dataset', { orgId });

      try {
        // Создаем сразу с правильными настройками
        const newDataset = await difyApi.createDataset(adminKey, expectedName);
        historyKbId = newDataset.id;

        logger.info('ensureHistoryKb: created new dataset with Hybrid Search & Rerank', {
          orgId,
          historyKbId,
        });
      } catch (error) {
        logger.error('ensureHistoryKb: error creating dataset', {
          orgId,
          error: error.message,
        });
        throw error;
      }
    }

    // 4. Update Cache
    // Сохраняем historyKbId, не затирая существующий adminKbId
    const existingAdminKbId =
      cachedData && cachedData.adminKbId ? cachedData.adminKbId : null;

    try {
      await redisCache.setOrgDatasets(orgId, {
        adminKbId: existingAdminKbId,
        historyKbId,
      });

      logger.debug('ensureHistoryKb: cache updated', {
        orgId,
        adminKbId: existingAdminKbId,
        historyKbId,
      });
    } catch (error) {
      logger.error('ensureHistoryKb: error updating cache', {
        orgId,
        error: error.message,
      });
      // Не выбрасываем ошибку, так как база уже создана/найдена
    }

    return historyKbId;
  }
}

// Экспортируем инстанс сервиса (Singleton)
module.exports = new OrganizationService();
