const logger = require('../utils/logger');
const OrganizationService = require('../services/OrganizationService');
const difyApi = require('../infrastructure/dify/api');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const { createErrorPayload } = require('../utils/errorHandler');
const { KbNotFoundError } = require('../core/errors');
const config = require('../config');

/**
 * Обработчик задачи CMD_GEN_RESPONSE
 * Этап 2: Логика поиска (Retrieval Logic)
 * Получает чанки из баз знаний без генерации ответа
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleGenResponse(job) {
  const { orgId, query, history, meta = {} } = job.data;

  logger.info('CMD_GEN_RESPONSE: Starting retrieval', {
    jobId: job.id,
    orgId,
    query: query?.substring(0, 50),
  });

  try {
    // Шаг 1: Identify Datasets - получение ID баз знаний
    let adminKbId, historyKbId;
    try {
      const kbIds = await OrganizationService.getKbIdsOrThrow(orgId);
      adminKbId = kbIds.adminKbId;
      historyKbId = kbIds.historyKbId;

      logger.info('CMD_GEN_RESPONSE: Knowledge base IDs retrieved', {
        jobId: job.id,
        orgId,
        adminKbId,
        historyKbId,
      });
    } catch (error) {
      if (error instanceof KbNotFoundError) {
        logger.error('CMD_GEN_RESPONSE: Knowledge base not found', {
          jobId: job.id,
          orgId,
          error: error.message,
        });

        // Отправка ошибки в resultQueue
        await sendResult('CMD_GEN_RESPONSE', createErrorPayload(error, meta), meta);
        return;
      }
      throw error;
    }

    // Шаг 2: Retrieval - параллельный поиск чанков из обеих баз
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    // Параллельный поиск с graceful degradation
    // Используем Promise.all для параллельного выполнения запросов
    const [adminChunks, historyChunks] = await Promise.all([
      // Для adminKbId: Top-3 чанка
      difyApi.retrieveChunks(adminKey, adminKbId, query, 3).catch((error) => {
        logger.warn('CMD_GEN_RESPONSE: Error retrieving admin chunks', {
          jobId: job.id,
          orgId,
          adminKbId,
          error: error.message,
        });
        // Graceful degradation: возвращаем пустой массив при ошибке
        return [];
      }),
      // Для historyKbId: Top-2 чанка
      difyApi.retrieveChunks(adminKey, historyKbId, query, 2).catch((error) => {
        logger.warn('CMD_GEN_RESPONSE: Error retrieving history chunks', {
          jobId: job.id,
          orgId,
          historyKbId,
          error: error.message,
        });
        // Graceful degradation: возвращаем пустой массив при ошибке
        return [];
      }),
    ]);

    // Шаг 3: Логирование найденных чанков
    logger.info('CMD_GEN_RESPONSE: Chunks retrieved', {
      jobId: job.id,
      orgId,
      adminChunksCount: adminChunks.length,
      historyChunksCount: historyChunks.length,
    });

    // Логирование первых нескольких чанков для проверки
    if (adminChunks.length > 0) {
      logger.debug('CMD_GEN_RESPONSE: Admin chunks preview', {
        jobId: job.id,
        orgId,
        chunks: adminChunks.slice(0, 3).map((chunk, index) => ({
          index,
          preview: chunk.content?.substring(0, 100) || chunk.text?.substring(0, 100) || '',
          score: chunk.score || null,
          source: chunk.source || null,
        })),
      });
    }

    if (historyChunks.length > 0) {
      logger.debug('CMD_GEN_RESPONSE: History chunks preview', {
        jobId: job.id,
        orgId,
        chunks: historyChunks.slice(0, 2).map((chunk, index) => ({
          index,
          preview: chunk.content?.substring(0, 100) || chunk.text?.substring(0, 100) || '',
          score: chunk.score || null,
          source: chunk.source || null,
        })),
      });
    }

    // Возврат результата в resultQueue
    const result = {
      success: true,
      data: {
        adminChunks,
        historyChunks,
        query,
        orgId,
      },
    };

    await sendResult('CMD_GEN_RESPONSE', result, meta);

    logger.info('CMD_GEN_RESPONSE: Result sent to result queue', {
      jobId: job.id,
      orgId,
      adminChunksCount: adminChunks.length,
      historyChunksCount: historyChunks.length,
    });
  } catch (error) {
    logger.error('CMD_GEN_RESPONSE: Unexpected error', {
      jobId: job.id,
      orgId,
      error: error.message,
      stack: error.stack,
    });

    // Отправка ошибки в resultQueue
    await sendResult('CMD_GEN_RESPONSE', createErrorPayload(error, meta), meta);
  }
}

/**
 * Fast Lane Worker - маршрутизация задач
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<any>} Результат выполнения задачи
 */
async function fastLaneWorker(job) {
  logger.info('Fast Lane job processing', {
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });

  // Маршрутизация задач через switch
  switch (job.name) {
    case 'CMD_GEN_RESPONSE':
      return await handleGenResponse(job);

    // Заглушки для будущих этапов
    case 'CMD_ANALYZE_NEW_TICKET':
      logger.warn('CMD_ANALYZE_NEW_TICKET: Not implemented yet', {
        jobId: job.id,
      });
      return { status: 'not_implemented', jobId: job.id };

    case 'CMD_TRANSLATE':
      logger.warn('CMD_TRANSLATE: Not implemented yet', {
        jobId: job.id,
      });
      return { status: 'not_implemented', jobId: job.id };

    case 'CMD_KB_LIST_FILES':
      logger.warn('CMD_KB_LIST_FILES: Not implemented yet', {
        jobId: job.id,
      });
      return { status: 'not_implemented', jobId: job.id };

    case 'CMD_KB_DELETE_FILE':
      logger.warn('CMD_KB_DELETE_FILE: Not implemented yet', {
        jobId: job.id,
      });
      return { status: 'not_implemented', jobId: job.id };

    default:
      logger.warn('Unknown job name', {
        jobId: job.id,
        jobName: job.name,
      });
      return { status: 'unknown_job', jobId: job.id };
  }
}

module.exports = fastLaneWorker;

