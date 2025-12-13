const { DifyApiError, KbNotFoundError } = require('../core/errors');
const logger = require('./logger');

/**
 * Нормализует ошибку в стандартизированную структуру с кодом ошибки
 * Используется в: src/utils/responseFormatter.js, src/utils/safeProcessor.js
 */
function normalizeError(error) {
  if (!error) {
    return {
      errorCode: 'INTERNAL_ERROR',
      message: 'Unknown system error',
    };
  }

  if (error instanceof DifyApiError) {
    const resourceNotFoundCodes = [
      'dataset_not_found',
      'knowledge_base_not_found',
      'dataset_not_initialized',
    ];

    const errorCode = error.difyCode || 'DIFY_API_ERROR';
    const isResourceNotFound =
      resourceNotFoundCodes.includes(errorCode) || error.statusCode === 404;

    return {
      errorCode: isResourceNotFound ? errorCode : errorCode || 'DIFY_API_ERROR',
      message: error.message || 'Dify API error',
      originalError: error,
    };
  }

  if (error instanceof KbNotFoundError) {
    return {
      errorCode: 'KB_NOT_FOUND',
      message: 'Knowledge base not initialized',
      originalError: error,
    };
  }

  if (error.message && error.message.includes('Unknown command:')) {
    return {
      errorCode: 'UNKNOWN_COMMAND',
      message: error.message,
      originalError: error,
    };
  }

  if (error.message && (
    error.message.includes('routing') ||
    error.message.includes('queue') ||
    error.name === 'RoutingError'
  )) {
    return {
      errorCode: 'ROUTING_ERROR',
      message: 'Failed to route job to target queue',
      originalError: error,
    };
  }

  if (error.name === 'ValidationError' ||
      (error.message && error.message.includes('validation'))) {
    return {
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid input data',
      originalError: error,
    };
  }

  if (error.isAxiosError || (error.request && !error.response)) {
    const errorCode =
      error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'NETWORK_ERROR';

    return {
      errorCode,
      message: 'Failed to connect to AI provider',
      originalError: error,
    };
  }

  if (error instanceof SyntaxError || error.name === 'SyntaxError') {
    return {
      errorCode: 'LLM_OUTPUT_PARSE_ERROR',
      message: 'Failed to process AI response',
      originalError: error,
    };
  }

  return {
    errorCode: 'INTERNAL_ERROR',
    message: error.message || 'Unknown system error',
    originalError: error,
  };
}

/**
 * Создает пейлоад ошибки в старом формате для обратной совместимости
 * @deprecated Используйте formatError из responseFormatter.js для нового формата
 * Используется в: src/workers/fastLaneWorker.js (handleGenResponse) - для обратной совместимости
 */
function createErrorPayload(error, meta = {}) {
  const normalized = normalizeError(error);

  return {
    status: 'error',
    errorCode: normalized.errorCode,
    message: normalized.message,
    meta,
  };
}

/**
 * Обрабатывает ошибки Dify API, связанные с отсутствием ресурсов, и инвалидирует кэш организации
 * Используется в: src/utils/safeProcessor.js, src/workers/*.js - для обработки ошибок ресурсов Dify
 */
async function handleDifyResourceError(error, orgId) {
  if (!(error instanceof DifyApiError)) {
    return normalizeError(error);
  }

  const resourceNotFoundCodes = [
    'dataset_not_found',
    'knowledge_base_not_found',
    'dataset_not_initialized',
  ];

  const isResourceNotFound =
    resourceNotFoundCodes.includes(error.difyCode) || error.statusCode === 404;

  if (isResourceNotFound && orgId) {
    try {
      let OrganizationService;
      try {
        OrganizationService = require('../services/OrganizationService');
      } catch (importError) {
        logger.warn('OrganizationService not available for cache invalidation', {
          error: importError.message,
        });
        return normalizeError(error);
      }

      if (OrganizationService && OrganizationService.invalidateOrgCache) {
        await OrganizationService.invalidateOrgCache(orgId);
        logger.warn('Cache invalidated due to Dify resource error', {
          orgId,
          errorCode: error.difyCode,
        });
      } else {
        logger.warn('OrganizationService.invalidateOrgCache not available', { orgId });
      }
    } catch (invalidationError) {
      logger.error('Error during cache invalidation', {
        orgId,
        error: invalidationError.message,
      });
    }
  }

  return normalizeError(error);
}

module.exports = {
  normalizeError,
  createErrorPayload,
  handleDifyResourceError,
};
