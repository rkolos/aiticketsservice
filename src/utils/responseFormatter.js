const { normalizeError } = require('./errorHandler');

/**
 * Перемещение usage из data в meta
 * @param {Object} data - Бизнес-данные с возможным полем usage
 * @returns {Object} Объект с очищенными данными и извлеченным usage
 */
function moveUsageToMeta(data) {
  if (!data || typeof data !== 'object') {
    return { data, usage: null };
  }

  const { usage, ...cleanData } = data;
  return {
    data: cleanData,
    usage: usage || null,
  };
}

/**
 * Обертка массива в объект с items и count
 * @param {Array} array - Массив данных
 * @returns {Object} Объект с items и count
 */
function wrapArray(array) {
  if (!Array.isArray(array)) {
    return {
      items: [],
      count: 0,
    };
  }

  return {
    items: array,
    count: array.length,
  };
}

/**
 * Форматирование успешного ответа в стандартный формат
 * @param {any} data - Бизнес-данные (может содержать usage, который будет перемещен в meta)
 * @param {Object} meta - Метаданные из исходной задачи
 * @param {string} jobId - ID задачи BullMQ
 * @param {number} startTime - Время начала обработки (Date.now())
 * @returns {Object} Стандартизированный ответ
 */
function formatSuccess(data, meta = {}, jobId, startTime) {
  // Извлекаем usage из data, если он там есть
  const { data: cleanData, usage } = moveUsageToMeta(data);

  // Вычисляем время обработки
  const processingTimeMs = startTime ? Date.now() - startTime : undefined;

  // Извлекаем traceId из разных возможных мест в meta
  const traceId = meta.traceId || meta.meta?.traceId || undefined;

  // Формируем стандартизированный ответ
  const result = {
    success: true,
    meta: {
      traceId,
      timestamp: Date.now(),
      jobId: jobId || undefined,
      ...(processingTimeMs !== undefined && { processingTimeMs }),
      ...(usage && { usage }),
      // Сохраняем остальные метаданные из исходного meta (кроме traceId и вложенного meta)
      ...Object.keys(meta).reduce((acc, key) => {
        if (key !== 'traceId' && key !== 'meta') {
          acc[key] = meta[key];
        }
        return acc;
      }, {}),
    },
    data: cleanData,
  };

  return result;
}

/**
 * Форматирование ошибки в стандартный формат
 * @param {Error} error - Объект ошибки
 * @param {Object} meta - Метаданные из исходной задачи
 * @param {string} jobId - ID задачи BullMQ
 * @param {number} startTime - Время начала обработки
 * @returns {Object} Стандартизированный ответ с ошибкой
 */
function formatError(error, meta = {}, jobId, startTime) {
  // Нормализуем ошибку через errorHandler
  const normalized = normalizeError(error);

  // Вычисляем время обработки
  const processingTimeMs = startTime ? Date.now() - startTime : undefined;

  // Формируем стандартизированный ответ с ошибкой
  const result = {
    success: false,
    meta: {
      traceId: meta.traceId || meta.meta?.traceId || undefined,
      timestamp: Date.now(),
      jobId: jobId || undefined,
      ...(processingTimeMs !== undefined && { processingTimeMs }),
      // Сохраняем остальные метаданные
      ...Object.keys(meta).reduce((acc, key) => {
        if (key !== 'traceId' && key !== 'meta') {
          acc[key] = meta[key];
        }
        return acc;
      }, {}),
    },
    error: {
      code: normalized.errorCode,
      message: normalized.message,
      ...(normalized.originalError && { details: normalized.originalError.message }),
      // Определяем retryable на основе типа ошибки
      retryable: isRetryableError(normalized.errorCode),
    },
  };

  return result;
}

/**
 * Определение, можно ли повторить запрос при данной ошибке
 * @param {string} errorCode - Код ошибки
 * @returns {boolean} true если ошибка retryable
 */
function isRetryableError(errorCode) {
  const retryableCodes = [
    'NETWORK_ERROR',
    'TIMEOUT',
    'DIFY_API_ERROR', // Может быть временная ошибка API
  ];

  const nonRetryableCodes = [
    'UNKNOWN_COMMAND',
    'VALIDATION_ERROR',
    'KB_NOT_FOUND',
    'LLM_OUTPUT_PARSE_ERROR',
    'INTERNAL_ERROR',
  ];

  if (nonRetryableCodes.includes(errorCode)) {
    return false;
  }

  if (retryableCodes.includes(errorCode)) {
    return true;
  }

  // По умолчанию не retryable для безопасности
  return false;
}

module.exports = {
  formatSuccess,
  formatError,
  wrapArray,
  moveUsageToMeta,
  isRetryableError,
};
