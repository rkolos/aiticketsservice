const { DifyApiError, KbNotFoundError } = require('../core/errors');
const logger = require('./logger');

/**
 * Нормализация ошибки в стандартизированную структуру
 * @param {Error} error - Объект ошибки
 * @returns {Object} Нормализованная ошибка { errorCode, message, originalError? }
 */
function normalizeError(error) {
  // Обработка null и undefined
  if (!error) {
    return {
      errorCode: 'INTERNAL_ERROR',
      message: 'Unknown system error',
    };
  }

  // Обработка DifyApiError
  if (error instanceof DifyApiError) {
    // Коды ошибок, указывающие на отсутствие ресурса
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
      originalError: error, // Для логирования
    };
  }

  // Обработка KbNotFoundError
  if (error instanceof KbNotFoundError) {
    return {
      errorCode: 'KB_NOT_FOUND',
      message: 'Knowledge base not initialized',
      originalError: error,
    };
  }

  // Обработка сетевых ошибок Axios
  if (error.isAxiosError || (error.request && !error.response)) {
    const errorCode = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' 
      ? 'TIMEOUT' 
      : 'NETWORK_ERROR';
    
    return {
      errorCode,
      message: 'Failed to connect to AI provider',
      originalError: error,
    };
  }

  // Обработка ошибок парсинга JSON
  if (error instanceof SyntaxError || error.name === 'SyntaxError') {
    return {
      errorCode: 'LLM_OUTPUT_PARSE_ERROR',
      message: 'Failed to process AI response',
      originalError: error,
    };
  }

  // Остальные ошибки
  return {
    errorCode: 'INTERNAL_ERROR',
    message: error.message || 'Unknown system error',
    originalError: error,
  };
}

/**
 * Создание финального пейлоада ошибки для очереди результатов
 * @param {Error} error - Объект ошибки
 * @param {Object} meta - Метаданные задачи (контекст)
 * @returns {Object} Пейлоад для очереди результатов
 */
function createErrorPayload(error, meta = {}) {
  const normalized = normalizeError(error);

  return {
    status: 'error',
    errorCode: normalized.errorCode,
    message: normalized.message,
    meta, // Критично: всегда возвращать контекст!
  };
}

/**
 * Обработка ошибок Dify, указывающих на отсутствие ресурса, с инвалидацией кэша
 * @param {DifyApiError} error - Ошибка Dify API
 * @param {string} orgId - ID организации
 * @returns {Object} Нормализованная ошибка
 */
async function handleDifyResourceError(error, orgId) {
  if (!(error instanceof DifyApiError)) {
    return normalizeError(error);
  }

  // Коды ошибок, указывающие на отсутствие ресурса
  const resourceNotFoundCodes = [
    'dataset_not_found',
    'knowledge_base_not_found',
    'dataset_not_initialized',
  ];

  const isResourceNotFound =
    resourceNotFoundCodes.includes(error.difyCode) ||
    error.statusCode === 404;

  // Если это ошибка отсутствия ресурса и есть orgId
  if (isResourceNotFound && orgId) {
    try {
      // Импорт OrganizationService (может быть еще не реализован)
      // Используем динамический импорт с обработкой ошибок
      let OrganizationService;
      try {
        OrganizationService = require('../services/OrganizationService');
      } catch (importError) {
        logger.warn(
          'OrganizationService not available for cache invalidation',
          { error: importError.message }
        );
        return normalizeError(error);
      }

      // Инвалидация кэша
      if (OrganizationService && OrganizationService.invalidateOrgCache) {
        await OrganizationService.invalidateOrgCache(orgId);
        logger.warn('Cache invalidated due to Dify resource error', {
          orgId,
          errorCode: error.difyCode,
        });
      } else {
        logger.warn(
          'OrganizationService.invalidateOrgCache not available',
          { orgId }
        );
      }
    } catch (invalidationError) {
      logger.error('Error during cache invalidation', {
        orgId,
        error: invalidationError.message,
      });
      // Продолжаем выполнение даже при ошибке инвалидации
    }
  }

  return normalizeError(error);
}

module.exports = {
  normalizeError,
  createErrorPayload,
  handleDifyResourceError,
};

