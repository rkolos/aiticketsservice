const logger = require('../utils/logger');
const config = require('../config');
const difyApi = require('../infrastructure/dify/api');
const OrganizationService = require('../services/OrganizationService');
const FileService = require('../services/FileService');
const createSafeProcessor = require('../utils/safeProcessor');
const ErrorHandler = require('../utils/errorHandler');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const { formatTicketHistory } = require('../utils/historyFormatter');
const BillingService = require('../services/BillingService');

/**
 * Процессор для Slow Lane (фоновые задачи)
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<any>} Результат выполнения задачи
 */
async function slowLaneProcessor(job) {
  logger.info('Slow job processing', {
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });

  switch (job.name) {
    case 'CMD_KB_ADD_FILE':
      return handleKbAddFile(job);
    case 'CMD_ARCHIVE_TICKET':
      return handleArchiveTicket(job);
    case 'CMD_SYS_RESYNC_CACHE':
      return handleSysResyncCache(job);
    case 'CMD_CLEANUP_ORG':
      return handleCleanupOrg(job);
    default:
      logger.warn('Unhandled slow-lane job type', { jobName: job.name });
      return { status: 'ignored', jobId: job.id, jobName: job.name };
  }
}

/**
 * Загрузка файла в базу знаний (Admin KB)
 */
async function handleKbAddFile(job) {
  const { orgId, fileUrl, fileName, meta = {} } = job.data || {};
  const adminKey = config.dify.keys.admin;
  let adminKbId;

  // Вспомогательная функция: читаем стрим в строку (для fallback)
  const streamToString = async (stream) => {
    return new Promise((resolve, reject) => {
      let data = '';
      stream.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
  };

  try {
    if (!adminKey) {
      throw new Error('DIFY admin key is not configured');
    }

    if (!orgId || !fileUrl || !fileName) {
      throw new Error('CMD_KB_ADD_FILE: missing required fields (orgId, fileUrl, fileName)');
    }

    // 1) Lazy init KB
    adminKbId = await OrganizationService.ensureAdminKb(orgId);
    logger.info('Admin KB ensured', { orgId, adminKbId });

    // 2) Download file
    const { stream, size } = await FileService.downloadStream(fileUrl);
    logger.info('File downloaded for upload', { fileName, size, orgId });

    // 3) Upload to Dify
    const uploadResult = await difyApi.uploadFile(adminKey, adminKbId, stream, fileName, 'system', size);
    const documentId = uploadResult?.document_id || uploadResult?.id;

    logger.info('File uploaded to Dify', {
      orgId,
      fileName,
      adminKbId,
      status: uploadResult?.status,
      documentId,
    });

    // 4) Try to get document info and indexing tokens
    let indexingTokens = null;
    let wordCount = null;

    try {
      // Wait for indexing to complete (with retries)
      const maxRetries = 10;
      const retryDelay = 2000; // 2 seconds

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));

        const documentInfo = await difyApi.getDocument(adminKey, adminKbId, documentId);
        const status = documentInfo?.indexing_status;

        if (status === 'completed') {
          indexingTokens = documentInfo?.tokens || null;
          wordCount = documentInfo?.word_count || null;

          logger.info('Document indexing completed', {
            orgId,
            documentId,
            indexingTokens,
            wordCount,
            attempts: attempt,
            indexingStatus: status,
          });
          break;
        } else if (status === 'error' || status === 'failed') {
          logger.warn('Document indexing failed', {
            orgId,
            documentId,
            indexingStatus: status,
            attempt,
          });
          break;
        } else {
          logger.info('Document still indexing', {
            orgId,
            documentId,
            indexingStatus: status,
            attempt,
            maxRetries,
          });
        }
      }

      // If still null after all retries, log warning
      if (indexingTokens === null) {
        logger.warn('Document indexing tokens not available after all retries', {
          orgId,
          documentId,
        });
      }
    } catch (error) {
      logger.warn('Could not retrieve document indexing info', {
        orgId,
        documentId,
        error: error.message,
      });
    }

    // Prepare usage data for file upload
    const fileUsage = indexingTokens ? {
      model: 'file-indexing',
      stages: [{
        prompt_tokens: 0,
        completion_tokens: indexingTokens,
        model: 'file-indexing',
        type: 'indexing'
      }],
    } : null;

    const payload = {
      status: 'success',
      data: {
        fileId: documentId,
        status: uploadResult?.status || 'indexing',
        fileName,
        orgId,
        usage: fileUsage,
      },
      meta: {
        jobId: job.id,
        ...meta,
      },
    };

    await sendResult('CMD_KB_ADD_FILE', payload, { orgId, fileUrl, fileName, ...meta });
    return payload;
  } catch (error) {
    logger.error('CMD_KB_ADD_FILE failed', {
      orgId,
      fileName,
      fileUrl,
      error: error.message,
    });

    // Инвалидация кэша при ошибках ресурсов Dify
    await ErrorHandler.handleDifyResourceError(error, orgId);

    // Fallback: если Dify требует indexing_technique и отклоняет uploadFile,
    // пробуем загрузить как текстовый документ.
    const isIndexingError =
      adminKbId &&
      (error?.message?.toLowerCase().includes('indexing_technique is required') ||
        error?.code === 'invalid_param');

    if (isIndexingError) {
      try {
        logger.warn('CMD_KB_ADD_FILE: fallback to createDocumentByText due to indexing_technique error', {
          orgId,
          fileName,
          fileUrl,
        });

        const { stream: retryStream } = await FileService.downloadStream(fileUrl);
        const fileText = await streamToString(retryStream);

        const createResult = await difyApi.createDocumentByText(adminKey, adminKbId, fileName, fileText);

        const payload = {
          status: 'success',
          data: {
            fileId: createResult?.document_id || createResult?.id || createResult?.task_id,
            status: createResult?.status || 'indexing',
            fileName,
            orgId,
            fallback: 'createDocumentByText',
          },
          meta: {
            jobId: job.id,
            ...meta,
          },
        };

        await sendResult('CMD_KB_ADD_FILE', payload, { orgId, fileUrl, fileName, ...meta });
        return payload;
      } catch (fallbackError) {
        logger.error('CMD_KB_ADD_FILE fallback failed', {
          orgId,
          fileName,
          fileUrl,
          error: fallbackError.message,
        });
        throw fallbackError;
      }
    }

    throw error;
  }
}

/**
 * Архивация тикета: суммаризация и запись в History KB
 */
async function handleArchiveTicket(job) {
  const { orgId, fullTicketHistory, lang, meta = {} } = job.data || {};
  const adminKey = config.dify.keys.admin;
  const summarizerKey = config.dify.keys.summarizer;

  try {
    if (!adminKey || !summarizerKey) {
      throw new Error('Dify keys (admin or summarizer) are not configured');
    }
    if (!orgId || !fullTicketHistory) {
      throw new Error('CMD_ARCHIVE_TICKET: missing required fields (orgId, fullTicketHistory)');
    }

    // 1) Lazy init History KB
    const historyKbId = await OrganizationService.ensureHistoryKb(orgId);
    logger.info('History KB ensured', { orgId, historyKbId });

    // 2) Форматирование истории
    const formattedHistory = formatTicketHistory(fullTicketHistory);

    // 3) Суммаризация
    const summarizeResult = await difyApi.runWorkflow(
      summarizerKey,
      {
        ticket_history: formattedHistory,
        language: lang, // Передаем значение (или undefined)
        // Для совместимости с конфигурациями, где message обязательна (ошибка "message is required")
        message: formattedHistory,
      },
      `archive-${orgId}-${Date.now()}`
    );

    const summaryText =
      (typeof summarizeResult === 'string' && summarizeResult) ||
      summarizeResult?.outputs?.text ||
      summarizeResult?.summary ||
      summarizeResult?.output ||
      summarizeResult?.text ||
      summarizeResult?.result ||
      JSON.stringify(summarizeResult);

    if (!summaryText) {
      throw new Error('Summarizer returned empty result');
    }

    // Извлечение usage через BillingService
    const workflowResponse = summarizeResult;

    const usage = BillingService.extractUsage(workflowResponse);

    logger.info('CMD_ARCHIVE_TICKET: Summarization usage extracted', {
      orgId,
      ticketId: meta.ticketId || job.id,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      ...(usage.model && { model: usage.model }),
    });

    // 4) Индексация в History KB
    const ticketId = meta.ticketId || job.id;
    const docName = `Ticket #${ticketId}`;
    const createResult = await difyApi.createDocumentByText(
      adminKey,
      historyKbId,
      docName,
      summaryText
    );


    const docId = createResult?.document?.id || createResult?.document_id || createResult?.id || createResult?.task_id;

    logger.info('Ticket archived to History KB', {
      orgId,
      historyKbId,
      ticketId,
      docId,
    });

    // 5) Try to get document indexing tokens
    let indexingTokens = null;
    let wordCount = null;

    try {
      // Wait for indexing to complete (with retries)
      const maxRetries = 8;
      const retryDelay = 1000; // 1 second for archive (usually faster)

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));

        const documentInfo = await difyApi.getDocument(adminKey, historyKbId, docId);
        const status = documentInfo?.indexing_status;

        if (status === 'completed') {
          indexingTokens = documentInfo?.tokens || null;
          wordCount = documentInfo?.word_count || null;

          logger.info('Archive document indexing completed', {
            orgId,
            docId,
            indexingTokens,
            wordCount,
            attempts: attempt,
            indexingStatus: status,
          });
          break;
        } else if (status === 'error' || status === 'failed') {
          logger.warn('Archive document indexing failed', {
            orgId,
            docId,
            indexingStatus: status,
            attempt,
          });
          break;
        } else {
          logger.debug('Archive document still indexing', {
            orgId,
            docId,
            indexingStatus: status,
            attempt,
            maxRetries,
          });
        }
      }

      // If still null after all retries, log warning
      if (indexingTokens === null) {
        logger.warn('Archive document indexing tokens not available after all retries', {
          orgId,
          docId,
        });
      }
    } catch (error) {
      logger.warn('Could not retrieve archive document indexing info', {
        orgId,
        docId,
        error: error.message,
      });
    }

    // Prepare usage data
    const usageStages = [usage];
    if (indexingTokens) {
      usageStages.push({
        prompt_tokens: 0, // Indexing tokens are completion-like
        completion_tokens: indexingTokens,
        model: 'indexing-model',
        type: 'indexing'
      });
    }

    const totalUsage = BillingService.accumulateUsage(usageStages);

    const payload = {
      status: 'success',
      data: {
        docId,
        docName,
        summary: summaryText,
        orgId,
        usage: {
          ...(totalUsage.model && { model: totalUsage.model }), // Включаем только если модель известна
          stages: totalUsage.stages,
        },
      },
      meta: {
        jobId: job.id,
        ...meta,
      },
    };

    await sendResult('CMD_ARCHIVE_TICKET', payload, { orgId, ticketId, ...meta });
    return payload;
  } catch (error) {
    logger.error('CMD_ARCHIVE_TICKET failed', {
      orgId,
      error: error.message,
    });

    await ErrorHandler.handleDifyResourceError(error, orgId);

    throw error;
  }
}

/**
 * Системная синхронизация кэша с Dify
 */
async function handleSysResyncCache(job) {
  const { meta = {} } = job.data || {};

  try {
    const stats = await OrganizationService.syncCacheWithDify();
    const payload = {
      status: 'success',
      data: stats,
      meta: {
        jobId: job.id,
        ...meta,
      },
    };
    await sendResult('CMD_SYS_RESYNC_CACHE', payload, meta);
    return payload;
  } catch (error) {
    logger.error('CMD_SYS_RESYNC_CACHE failed', {
      error: error.message,
    });

    throw error;
  }
}

/**
 * Очистка ресурсов организации: удаление датасетов и кэша
 */
async function handleCleanupOrg(job) {
  const { orgId, meta = {} } = job.data || {};
  const adminKey = config.dify.keys.admin;

  try {
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }
    if (!orgId) {
      throw new Error('CMD_CLEANUP_ORG: orgId is required');
    }

    // Получить ID баз из кэша/ошибку, если нет
    const { adminKbId, historyKbId } = await OrganizationService.getKbIdsOrThrow(orgId);

    // Удалить датасеты в Dify (игнорировать, если уже удалены)
    const tasks = [];
    if (adminKbId) {
      tasks.push(
        difyApi.deleteDataset(adminKey, adminKbId).catch((err) => {
          logger.warn('Failed to delete admin KB dataset', { orgId, adminKbId, error: err.message });
        })
      );
    }
    if (historyKbId) {
      tasks.push(
        difyApi.deleteDataset(adminKey, historyKbId).catch((err) => {
          logger.warn('Failed to delete history KB dataset', { orgId, historyKbId, error: err.message });
        })
      );
    }
    await Promise.all(tasks);

    // Очистить кэш
    await OrganizationService.invalidateOrgCache(orgId, 'cleanup_org');

    const payload = {
      status: 'success',
      data: {
        orgId,
        deleted: {
          adminKbId,
          historyKbId,
        },
      },
      meta: {
        jobId: job.id,
        ...meta,
      },
    };

    await sendResult('CMD_CLEANUP_ORG', payload, { orgId, ...meta });
    return payload;
  } catch (error) {
    logger.error('CMD_CLEANUP_ORG failed', {
      orgId,
      error: error.message,
    });

    await ErrorHandler.handleDifyResourceError(error, orgId);

    throw error;
  }
}

module.exports = createSafeProcessor('SlowLane', slowLaneProcessor);
