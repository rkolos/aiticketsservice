const Redis = require('ioredis');
const config = require('../../config');
const logger = require('../../utils/logger');

// Конфигурация Redis клиента для бизнес-кэширования
const redisConfig = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null, // Для консистентности, хотя этот клиент не используется для BullMQ
};

// Добавляем пароль, если он задан
if (config.redis.password) {
  redisConfig.password = config.redis.password;
}

// Singleton инстанс Redis клиента
// ВАЖНО: Этот клиент используется ТОЛЬКО для бизнес-кэширования (маппинг OrgID -> Dataset IDs)
// НЕ используется для BullMQ воркеров, так как они требуют эксклюзивных соединений
const redisClient = new Redis(redisConfig);

// Подписка на события соединения
redisClient.on('connect', () => {
  logger.info('Redis connecting...');
});

redisClient.on('ready', () => {
  logger.info('Redis connected and ready');
});

redisClient.on('error', (error) => {
  logger.error('Redis connection error', { error: error.message });
});

redisClient.on('close', () => {
  logger.warn('Redis connection closed');
});

module.exports = redisClient;

