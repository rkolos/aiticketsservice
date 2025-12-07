const redisCache = require('../infrastructure/redis/cache');
const logger = require('../utils/logger');
const { KbNotFoundError } = require('../core/errors');
const difyApi = require('../infrastructure/dify/api');
const config = require('../config');

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
    const limit = 50; // Размер страницы
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
}

// Экспортируем инстанс сервиса (Singleton)
module.exports = new OrganizationService();
