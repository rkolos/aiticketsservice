const { Queue } = require('bullmq');
const Redis = require('ioredis');
const config = require('../../config');
const logger = require('../../utils/logger');
const { QUEUES } = require('../../core/constants');

// Создаем отдельное соединение Redis для очереди результатов
// ВАЖНО: Не используем синглтон из src/infrastructure/redis/client.js
const connection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: null, // Обязательное требование BullMQ
});

// Обработка ошибок соединения Redis
connection.on('error', (error) => {
  logger.error('Redis connection error in result queue', {
    error: error.message,
    stack: error.stack,
  });
});

connection.on('close', () => {
  logger.warn('Redis connection closed in result queue');
});

// Создаем очередь результатов
const resultQueue = new Queue(QUEUES.RESULTS, {
  connection,
  defaultJobOptions: {
    removeOnComplete: {
      count: 1000,
    },
    removeOnFail: {
      count: 5000,
    },
  },
});

// Логирование событий очереди
resultQueue.on('error', (error) => {
  logger.error('Result queue error', { error: error.message });
});

/**
 * Отправить результат выполнения задачи
 * @param {string} jobName - Имя задачи
 * @param {Object} data - Данные результата
 * @param {Object} meta - Метаданные (контекст из исходной задачи)
 * @returns {Promise<Job>}
 */
async function sendResult(jobName, data, meta = {}) {
  try {
    const job = await resultQueue.add(jobName, {
      ...data,
      meta,
    });

    logger.debug('Result sent', {
      jobId: job.id,
      jobName,
    });

    return job;
  } catch (error) {
    logger.error('Error sending result', {
      jobName,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  resultQueue,
  sendResult,
  // Экспортируем соединение для возможности закрытия в тестах
  connection,
};

