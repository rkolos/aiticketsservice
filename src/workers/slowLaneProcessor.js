const logger = require('../utils/logger');
const config = require('../config');
const difyApi = require('../infrastructure/dify/api');
const OrganizationService = require('../services/OrganizationService');
const FileService = require('../services/FileService');
const ErrorHandler = require('../utils/errorHandler');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const { formatTicketHistory } = require('../utils/historyFormatter');

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

  try {
    if (!adminKey) {
      throw new Error('DIFY admin key is not configured');
    }

    if (!orgId || !fileUrl || !fileName) {
      throw new Error('CMD_KB_ADD_FILE: missing required fields (orgId, fileUrl, fileName)');
    }

    // 1) Lazy init KB
    const adminKbId = await OrganizationService.ensureAdminKb(orgId);
    logger.info('Admin KB ensured', { orgId, adminKbId });

    // 2) Download file
    const { stream, size } = await FileService.downloadStream(fileUrl);
    logger.info('File downloaded for upload', { fileName, size, orgId });

    // 3) Upload to Dify
    const uploadResult = await difyApi.uploadFile(adminKey, adminKbId, stream, fileName, 'system', size);
    logger.info('File uploaded to Dify', {
      orgId,
      fileName,
      adminKbId,
      status: uploadResult?.status,
      documentId: uploadResult?.document_id || uploadResult?.id,
    });

    const payload = {
      status: 'success',
      data: {
        fileId: uploadResult?.document_id || uploadResult?.id,
        status: uploadResult?.status || 'indexing',
        fileName,
        orgId,
      },
      meta: {
        jobId: job.id,
        ...meta,
      },
    };

    await sendResult('CMD_KB_ADD_FILE', payload, { orgId, fileUrl, fileName });
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

    const errorPayload = ErrorHandler.createErrorPayload(error, {
      jobId: job.id,
      orgId,
      fileUrl,
      fileName,
      ...meta,
    });

    await sendResult('CMD_KB_ADD_FILE_ERROR', errorPayload, { orgId, fileUrl, fileName });
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
      },
      `archive-${orgId}-${Date.now()}`
    );

    const summaryText =
      (typeof summarizeResult === 'string' && summarizeResult) ||
      summarizeResult?.summary ||
      summarizeResult?.output ||
      summarizeResult?.text ||
      summarizeResult?.result ||
      JSON.stringify(summarizeResult);

    if (!summaryText) {
      throw new Error('Summarizer returned empty result');
    }

    // 4) Индексация в History KB
    const ticketId = meta.ticketId || job.id;
    const docName = `Ticket #${ticketId}`;
    const createResult = await difyApi.createDocumentByText(
      adminKey,
      historyKbId,
      docName,
      summaryText
    );

    logger.info('Ticket archived to History KB', {
      orgId,
      historyKbId,
      ticketId,
      docId: createResult?.document_id || createResult?.id,
    });

    const payload = {
      status: 'success',
      data: {
        docId: createResult?.document_id || createResult?.id,
        docName,
        summary: summaryText,
        orgId,
      },
      meta: {
        jobId: job.id,
        ...meta,
      },
    };

    await sendResult('CMD_ARCHIVE_TICKET', payload, { orgId, ticketId });
    return payload;
  } catch (error) {
    logger.error('CMD_ARCHIVE_TICKET failed', {
      orgId,
      error: error.message,
    });

    await ErrorHandler.handleDifyResourceError(error, orgId);

    const errorPayload = ErrorHandler.createErrorPayload(error, {
      jobId: job.id,
      orgId,
      ...meta,
    });

    await sendResult('CMD_ARCHIVE_TICKET_ERROR', errorPayload, { orgId });
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

    const errorPayload = ErrorHandler.createErrorPayload(error, {
      jobId: job.id,
      ...meta,
    });

    await sendResult('CMD_SYS_RESYNC_CACHE_ERROR', errorPayload, meta);
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

    await sendResult('CMD_CLEANUP_ORG', payload, { orgId });
    return payload;
  } catch (error) {
    logger.error('CMD_CLEANUP_ORG failed', {
      orgId,
      error: error.message,
    });

    await ErrorHandler.handleDifyResourceError(error, orgId);

    const errorPayload = ErrorHandler.createErrorPayload(error, {
      jobId: job.id,
      orgId,
      ...meta,
    });

    await sendResult('CMD_CLEANUP_ORG_ERROR', errorPayload, { orgId });
    throw error;
  }
}

module.exports = slowLaneProcessor;
