const logger = require('../utils/logger');
const config = require('../config');
const difyApi = require('../infrastructure/dify/api');
const OrganizationService = require('../services/OrganizationService');
const FileService = require('../services/FileService');
const ErrorHandler = require('../utils/errorHandler');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');

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

module.exports = slowLaneProcessor;
