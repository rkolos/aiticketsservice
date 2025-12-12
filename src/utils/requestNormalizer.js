/**
 * Нормализация входных данных задачи для унификации формата
 */

/**
 * Извлечение текстового контента из данных задачи
 * Поддерживает разные варианты: text, query, content
 * @param {Object} data - Данные задачи
 * @returns {string|undefined} Текстовый контент
 */
function extractContent(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  return data.content || data.text || data.query || undefined;
}

/**
 * Извлечение целевого языка из данных задачи
 * Поддерживает разные варианты: targetLanguage, targetLang, lang
 * @param {Object} data - Данные задачи
 * @returns {string|undefined} Целевой язык
 */
function extractTargetLang(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  // Проверяем в params, если есть
  if (data.params && data.params.targetLang) {
    return data.params.targetLang;
  }

  // Проверяем в корне данных
  return data.targetLang || data.targetLanguage || data.lang || undefined;
}

/**
 * Извлечение orgId из данных задачи
 * Может быть в data.orgId или в meta.orgId
 * @param {Object} data - Данные задачи
 * @returns {string|undefined} ID организации
 */
function extractOrgId(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  return data.orgId || data.meta?.orgId || undefined;
}

/**
 * Нормализация входных данных задачи
 * Унифицирует формат для обработки в воркерах
 * @param {Object} jobData - Данные задачи из BullMQ
 * @returns {Object} Нормализованные данные
 */
function normalizeRequest(jobData) {
  if (!jobData || typeof jobData !== 'object') {
    return jobData;
  }

  // Если данные уже в новом формате (с payload), возвращаем как есть
  if (jobData.payload) {
    return jobData;
  }

  // Извлекаем метаданные
  const meta = jobData.meta || {};

  // Извлекаем основные поля
  const content = extractContent(jobData);
  const targetLang = extractTargetLang(jobData);
  const orgId = extractOrgId(jobData);

  // Формируем нормализованный объект
  const normalized = {
    ...jobData,
    meta: {
      ...meta,
      ...(orgId && !meta.orgId && { orgId }),
    },
  };

  // Если есть content или targetLang, создаем структуру payload для совместимости
  if (content || targetLang) {
    normalized.content = content;
    if (targetLang) {
      normalized.targetLang = targetLang;
      // Также сохраняем в params для совместимости с новым форматом
      if (!normalized.params) {
        normalized.params = {};
      }
      normalized.params.targetLang = targetLang;
    }
  }

  return normalized;
}

/**
 * Извлечение всех параметров из данных задачи
 * Объединяет params и корневые поля
 * @param {Object} data - Данные задачи
 * @returns {Object} Объект с параметрами
 */
function extractParams(data) {
  if (!data || typeof data !== 'object') {
    return {};
  }

  const params = data.params || {};
  const targetLang = extractTargetLang(data);

  return {
    ...params,
    ...(targetLang && { targetLang }),
  };
}

module.exports = {
  normalizeRequest,
  extractContent,
  extractTargetLang,
  extractOrgId,
  extractParams,
};
