const createWorker = require('./factory');
const { QUEUES } = require('../../core/constants');
const config = require('../../config');
const logger = require('../../utils/logger');
const fastLaneWorker = require('../../workers/fastLaneWorker');
const slowLaneProcessor = require('../../workers/slowLaneProcessor');

/**
 * Инициализация всех воркеров BullMQ
 * 
 * ВАЖНО: Настройки concurrency берутся из конфига (config.workers.*),
 * который читает значения из .env файла. Это позволяет тюнить производительность
 * без пересборки контейнера.
 * 
 * @returns {Object} Объект с воркерами
 */
function initWorkers() {
  logger.info('Initializing BullMQ workers...');

  // Воркер 1: Fast Lane (Интерактивная очередь)
  const fastLaneWorkerInstance = createWorker(
    QUEUES.INTERACTIVE,
    fastLaneWorker,
    {
      concurrency: config.workers.fastLane.concurrency, // Из .env: WORKER_FAST_LANE_CONCURRENCY
      // Рекомендуется консервативное значение (10-20) для self-hosted Dify
      // Высокий параллелизм может перегрузить базу данных Dify и векторную базу
    }
  );

  logger.info('Fast Lane worker initialized', {
    queue: QUEUES.INTERACTIVE,
    concurrency: config.workers.fastLane.concurrency,
  });

  // Воркер 2: Slow Lane (Фоновая очередь)
  const slowLaneWorker = createWorker(
    QUEUES.BACKGROUND,
    slowLaneProcessor,
    {
      concurrency: config.workers.slowLane.concurrency, // Из .env: WORKER_SLOW_LANE_CONCURRENCY
      // Жесткое ограничение для предотвращения перегрузки Dify
      // При загрузке файлов процесс индексации очень ресурсоемкий
      limiter: {
        max: config.workers.slowLane.rateLimiter.fileUpload.max,
        duration: config.workers.slowLane.rateLimiter.fileUpload.duration,
      },
      // Rate Limiter ограничивает частоту обработки задач загрузки файлов
      // максимум 1 файл в секунду для защиты Dify от перегрузки
    }
  );

  logger.info('Slow Lane worker initialized', {
    queue: QUEUES.BACKGROUND,
    concurrency: config.workers.slowLane.concurrency,
    rateLimiter: config.workers.slowLane.rateLimiter.fileUpload,
  });

  return {
    fastLaneWorker: fastLaneWorkerInstance,
    slowLaneWorker,
  };
}

module.exports = {
  initWorkers,
};

