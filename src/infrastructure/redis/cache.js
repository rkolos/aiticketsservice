const redisClient = require('./client');
const logger = require('../../utils/logger');

const KEY_PREFIX = 'ticket-ai:org:';

/**
 * Получить ID баз знаний для организации
 * @param {string} orgId - ID организации
 * @returns {Promise<{adminKbId: string, historyKbId: string} | null>}
 */
async function getOrgDatasets(orgId) {
  try {
    const key = `${KEY_PREFIX}${orgId}`;
    const data = await redisClient.get(key);

    if (!data) {
      return null;
    }

    return JSON.parse(data);
  } catch (error) {
    logger.error('Error getting org datasets from cache', { orgId, error: error.message });
    throw error;
  }
}

/**
 * Сохранить ID баз знаний для организации
 * @param {string} orgId - ID организации
 * @param {Object} datasets - Объект с ID баз знаний
 * @param {string} datasets.adminKbId - ID админской базы знаний
 * @param {string} datasets.historyKbId - ID базы знаний истории
 * @returns {Promise<void>}
 */
async function setOrgDatasets(orgId, { adminKbId, historyKbId }) {
  try {
    const key = `${KEY_PREFIX}${orgId}`;
    const value = JSON.stringify({ adminKbId, historyKbId });
    await redisClient.set(key, value);
    // Без TTL - храним вечно, пока не будет явной очистки
  } catch (error) {
    logger.error('Error setting org datasets in cache', { orgId, error: error.message });
    throw error;
  }
}

/**
 * Массовая вставка маппингов организаций (для Cache Warming)
 * @param {Array<Object>} mappings - Массив объектов с данными организаций
 * @param {string} mappings[].orgId - ID организации
 * @param {string} mappings[].adminKbId - ID админской базы знаний
 * @param {string} mappings[].historyKbId - ID базы знаний истории
 * @returns {Promise<void>}
 */
async function msetOrgDatasets(mappings) {
  try {
    const pipeline = redisClient.pipeline();

    mappings.forEach(({ orgId, adminKbId, historyKbId }) => {
      const key = `${KEY_PREFIX}${orgId}`;
      const value = JSON.stringify({ adminKbId, historyKbId });
      pipeline.set(key, value);
    });

    await pipeline.exec();
  } catch (error) {
    logger.error('Error setting multiple org datasets in cache', { error: error.message });
    throw error;
  }
}

/**
 * Удалить ID баз знаний для организации
 * @param {string} orgId - ID организации
 * @returns {Promise<void>}
 */
async function deleteOrgDatasets(orgId) {
  try {
    const key = `${KEY_PREFIX}${orgId}`;
    await redisClient.del(key);
  } catch (error) {
    logger.error('Error deleting org datasets from cache', { orgId, error: error.message });
    throw error;
  }
}

/**
 * Очистить весь кэш организаций (только ключи ticket-ai:org:*)
 * ВАЖНО: Использует SCAN для безопасного удаления, не затрагивая ключи BullMQ
 * @returns {Promise<void>}
 */
async function flushCache() {
  try {
    const stream = redisClient.scanStream({
      match: `${KEY_PREFIX}*`,
      count: 100,
    });

    const keysToDelete = [];
    stream.on('data', (keys) => {
      keysToDelete.push(...keys);
    });

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (keysToDelete.length > 0) {
      await redisClient.del(...keysToDelete);
      logger.info(`Flushed ${keysToDelete.length} org cache keys`);
    } else {
      logger.info('No org cache keys to flush');
    }
  } catch (error) {
    logger.error('Error flushing org cache', { error: error.message });
    throw error;
  }
}

module.exports = {
  getOrgDatasets,
  setOrgDatasets,
  msetOrgDatasets,
  deleteOrgDatasets,
  flushCache,
};

