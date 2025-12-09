const { Queue } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const { QUEUES } = require('../core/constants');

// Создаем соединения Redis для очередей маршрутизации
// ВАЖНО: Используем отдельные соединения для каждой очереди, как в resultQueue.js
const fastQueueConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: null, // Обязательное требование BullMQ
});

const slowQueueConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: null, // Обязательное требование BullMQ
});

// Обработка ошибок соединений Redis
fastQueueConnection.on('error', (error) => {
  logger.error('Redis connection error in fast queue (router)', {
    error: error.message,
    stack: error.stack,
  });
});

slowQueueConnection.on('error', (error) => {
  logger.error('Redis connection error in slow queue (router)', {
    error: error.message,
    stack: error.stack,
  });
});

fastQueueConnection.on('close', () => {
  logger.warn('Redis connection closed in fast queue (router)');
});

slowQueueConnection.on('close', () => {
  logger.warn('Redis connection closed in slow queue (router)');
});

// Создаем очереди для маршрутизации
const fastQueue = new Queue(QUEUES.INTERACTIVE, {
  connection: fastQueueConnection,
});

const slowQueue = new Queue(QUEUES.BACKGROUND, {
  connection: slowQueueConnection,
});

// Команды, которые должны обрабатываться в Fast Lane (интерактивные)
const FAST_COMMANDS = [
  'CMD_GEN_RESPONSE',
  'CMD_ANALYZE_NEW_TICKET',
  'CMD_TRANSLATE',
  'CMD_KB_LIST_FILES',
  'CMD_KB_DELETE_FILE',
];

/**
 * Router Processor - маршрутизирует задачи из единой входной очереди
 * в соответствующие внутренние очереди (Fast или Slow Lane)
 * 
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<Object>} Результат маршрутизации
 */
async function routerProcessor(job) {
  const { name, data } = job;

  logger.info('Router: processing job', {
    jobId: job.id,
    jobName: name,
  });

  try {
    // Определяем целевую очередь на основе типа команды
    const isFastCommand = FAST_COMMANDS.includes(name);
    const targetQueue = isFastCommand ? fastQueue : slowQueue;
    const targetQueueName = isFastCommand ? QUEUES.INTERACTIVE : QUEUES.BACKGROUND;

    // Добавляем задачу в целевую очередь с теми же данными
    // Сохраняем все поля: data, meta, lang и т.д.
    const routedJob = await targetQueue.add(name, data, {
      // Сохраняем опции из исходной задачи, если они есть
      ...(job.opts || {}),
    });

    logger.info('Router: job routed', {
      jobId: job.id,
      jobName: name,
      targetQueue: targetQueueName,
      routedJobId: routedJob.id,
    });

    return {
      status: 'routed',
      to: isFastCommand ? 'fast' : 'slow',
      targetQueue: targetQueueName,
      routedJobId: routedJob.id,
    };
  } catch (error) {
    logger.error('Router: error routing job', {
      jobId: job.id,
      jobName: name,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Экспортируем соединения для возможности закрытия в тестах
module.exports = routerProcessor;
module.exports.fastQueueConnection = fastQueueConnection;
module.exports.slowQueueConnection = slowQueueConnection;
module.exports.fastQueue = fastQueue;
module.exports.slowQueue = slowQueue;

