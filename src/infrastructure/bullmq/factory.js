const { Worker } = require('bullmq');
const Redis = require('ioredis');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Фабрика для создания BullMQ воркеров
 * 
 * ВАЖНО: Каждый воркер создает свои собственные соединения Redis,
 * изолированные от клиента кэширования (src/infrastructure/redis/client.js).
 * Это необходимо, так как BullMQ использует блокирующие команды Redis.
 * 
 * @param {string} queueName - Имя очереди
 * @param {Function} processor - Функция-обработчик задач
 * @param {Object} options - Дополнительные опции для воркера
 * @returns {Worker} Инстанс BullMQ Worker
 */
function createWorker(queueName, processor, options = {}) {
  // Создаем новое соединение Redis для воркера (не используем синглтон!)
  const connection = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    maxRetriesPerRequest: null, // Обязательное требование BullMQ
  });

  // Обработка ошибок соединения Redis
  connection.on('error', (error) => {
    logger.error('Redis connection error in worker', {
      queue: queueName,
      error: error.message,
      stack: error.stack,
    });
  });

  connection.on('close', () => {
    logger.warn('Redis connection closed in worker', { queue: queueName });
  });

  // Дефолтные настройки
  const defaultOptions = {
    connection,
    defaultJobOptions: {
      attempts: config.workers.retry.attempts,
      backoff: {
        type: 'exponential',
        delay: config.workers.retry.backoffDelay, // 1s, 2s, 4s
      },
      removeOnComplete: {
        count: 1000, // Хранить последние 1000 успешных задач
      },
      removeOnFail: {
        count: 5000, // Хранить последние 5000 неудачных задач
      },
    },
  };

  // Мержим с переданными опциями
  const workerOptions = {
    ...defaultOptions,
    ...options,
    // Переопределяем defaultJobOptions, если они переданы
    defaultJobOptions: {
      ...defaultOptions.defaultJobOptions,
      ...(options.defaultJobOptions || {}),
    },
  };

  // Создаем воркер
  const worker = new Worker(queueName, processor, workerOptions);

  // Подписка на события
  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`, {
      queue: queueName,
      jobName: job.name,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id || 'unknown'} failed`, {
      queue: queueName,
      jobName: job?.name || 'unknown',
      reason: err.message,
      stack: err.stack,
    });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', {
      queue: queueName,
      error: err.message,
      stack: err.stack,
    });
  });

  return worker;
}

module.exports = createWorker;

