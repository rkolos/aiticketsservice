const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const ErrorHandler = require('./errorHandler');
const { formatError } = require('./responseFormatter');
const logger = require('./logger');

/**
 * Функция высшего порядка для безопасного выполнения процессоров
 *
 * Гарантирует, что любое исключение будет перехвачено, нормализовано
 * и отправлено в очередь результатов перед тем, как задача будет помечена как failed.
 *
 * @param {string} processorName - Имя процессора для логирования
 * @param {Function} processorFn - Функция-процессор для обёртки
 * @returns {Function} Обёрнутая функция-процессор
 */
const createSafeProcessor = (processorName, processorFn) => async (job) => {
  const startTime = Date.now();
  
  try {
    return await processorFn(job);
  } catch (error) {
    // 1. Логирование ошибки
    logger.error(`Processor ${processorName} failed`, {
      jobId: job.id,
      jobName: job.name,
      error: error.message,
      stack: error.stack
    });

    // 2. Инвалидация кэша (если применимо, можно вынести внутрь ErrorHandler)
    if (job.data && job.data.orgId) {
      try {
        await ErrorHandler.handleDifyResourceError(error, job.data.orgId);
      } catch (cacheError) {
        logger.warn('Cache invalidation failed during error handling', {
          jobId: job.id,
          originalError: error.message,
          cacheError: cacheError.message
        });
      }
    }

    // 3. Формирование ответа для внешнего сервиса в стандартизированном формате
    // Важно: берем meta из job.data, чтобы сервис мог сопоставить ответ
    const meta = job.data?.meta || {};
    const errorPayload = formatError(error, {
      jobId: job.id,
      jobName: job.name,
      ...meta
    }, job.id, startTime);

    // 4. Отправка в очередь результатов (Гарантированная доставка ошибки)
    try {
      await sendResult(job.name, errorPayload, {
        jobId: job.id,
        jobName: job.name,
        ...meta
      });
    } catch (sendError) {
      logger.error('CRITICAL: Failed to send error result', {
        originalError: error.message,
        sendError: sendError.message,
        jobId: job.id,
        jobName: job.name
      });
    }

    // 5. Пробрасываем ошибку, чтобы BullMQ пометил задачу как Failed
    // Это запустит механизм Retry (если настроен)
    throw error;
  }
};

module.exports = createSafeProcessor;
