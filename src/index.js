const config = require('./config');
const logger = require('./utils/logger');
const redisClient = require('./infrastructure/redis/client');
const difyApi = require('./infrastructure/dify/api');
const { initWorkers } = require('./infrastructure/bullmq');
const { resultQueue } = require('./infrastructure/bullmq/resultQueue');
const OrganizationService = require('./services/OrganizationService');
const { startHealthcheckServer } = require('./infrastructure/healthcheck/server');

/**
 * Маскирует секретные данные в конфигурации для безопасного логирования
 * Используется в: src/index.js (startApp) - для логирования конфигурации при старте приложения
 */
function maskSecrets(configObj) {
  const masked = JSON.parse(JSON.stringify(configObj));
  if (masked.redis?.password) {
    masked.redis.password = '***';
  }
  if (masked.dify?.keys) {
    Object.keys(masked.dify.keys).forEach((key) => {
      if (masked.dify.keys[key]) {
        masked.dify.keys[key] = '***';
      }
    });
  }
  return masked;
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

/**
 * Инициализирует подключение к Redis и ожидает готовности клиента
 * Используется в: src/index.js (startApp) - для проверки доступности Redis перед запуском приложения
 */
async function initRedis() {
  return new Promise((resolve, reject) => {
    if (redisClient.status === 'ready') {
      resolve();
      return;
    }

    redisClient.once('ready', () => {
      resolve();
    });

    redisClient.once('error', (error) => {
      reject(error);
    });

    redisClient
      .ping()
      .then(() => {
        if (redisClient.status === 'ready') {
          resolve();
        }
      })
      .catch(reject);
  });
}

/**
 * Проверяет доступность Dify API через тестовый запрос
 * Используется в: src/index.js (startApp) - для проверки доступности Dify API при старте приложения
 */
async function testDifyConnection() {
  try {
    logger.info('Testing Dify API connection...');
    const adminKey = config.dify.keys.admin;

    if (!adminKey) {
      logger.warn('Dify admin key not configured, skipping API test');
      return;
    }

    const result = await difyApi.listDatasets(adminKey, 1, 10);
    logger.info('Dify API connection test successful', {
      datasetsCount: result.data?.length || 0,
      total: result.total || 0,
    });
  } catch (error) {
    logger.warn('Dify API connection test failed (this is OK if Dify is not running)', {
      error: error.message,
      statusCode: error.statusCode || null,
    });
  }
}

let workers = null;
let server = null;

/**
 * Выполняет корректное завершение работы приложения: закрывает воркеры, очереди и соединения
 * Используется в: src/index.js - обработчики сигналов SIGTERM и SIGINT для graceful shutdown
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    if (workers) {
      logger.info('Closing workers...');
      await Promise.all([
        workers.fastLaneWorker.close(),
        workers.slowLaneWorker.close(),
      ]);
      logger.info('Workers closed');
    }

    logger.info('Closing result queue...');
    await resultQueue.close();
    logger.info('Result queue closed');

    logger.info('Closing Redis cache client...');
    redisClient.disconnect();
    logger.info('Redis cache client closed');

    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Инициализирует и запускает приложение: проверяет подключения, синхронизирует кэш, запускает воркеры и healthcheck сервер
 * Используется в: src/index.js - точка входа приложения, вызывается при старте
 */
async function startApp() {
  try {
    await initRedis();
    logger.info('Redis connection verified');

    await testDifyConnection();

    try {
      logger.info('Cache warming started...');
      const stats = await OrganizationService.syncCacheWithDify();
      logger.info('Cache warming completed', stats);
    } catch (error) {
      logger.error('Cache warming failed', {
        error: error.message,
        stack: error.stack,
      });
      logger.warn('Continuing with empty cache - cache will be populated on demand');
    }

    workers = initWorkers();
    logger.info('BullMQ workers initialized');

    server = await startHealthcheckServer(workers);

    logger.info('Ticket AI Worker started', {
      config: maskSecrets(config),
    });
  } catch (error) {
    logger.error('Failed to start application', { error: error.message });
    process.exit(1);
  }
}

startApp();

