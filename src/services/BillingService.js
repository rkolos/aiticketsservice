const logger = require('../utils/logger');

/**
 * Извлечение и нормализация данных о потреблении ресурсов из ответа Dify
 * @param {Object} difyResponse - Полный JSON-ответ от Dify API
 * @param {string} defaultModel - Название модели по умолчанию (fallback)
 * @returns {Object} Объект с данными о токенах: { prompt_tokens, completion_tokens, total_tokens, model }
 */
function extractUsage(difyResponse, defaultModel = 'gpt-4') {
  // Обработка null и undefined
  if (!difyResponse || typeof difyResponse !== 'object') {
    logger.warn('extractUsage: invalid response, returning zero usage', {
      responseType: typeof difyResponse,
    });
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      model: defaultModel,
    };
  }

  let usage = null;
  let modelName = defaultModel;

  // Поиск usage в разных местах ответа Dify
  // 1. Стандартный путь для Chatflow
  if (difyResponse.metadata && difyResponse.metadata.usage) {
    usage = difyResponse.metadata.usage;
  }
  // 2. Альтернативный путь для Workflow (иногда встречается в outputs)
  else if (
    difyResponse.data &&
    difyResponse.data.outputs &&
    difyResponse.data.outputs.usage
  ) {
    usage = difyResponse.data.outputs.usage;
  }
  // 3. Прямой путь (если usage на верхнем уровне)
  else if (difyResponse.usage) {
    usage = difyResponse.usage;
  }

  // Поиск названия модели
  if (difyResponse.metadata && difyResponse.metadata.model_name) {
    modelName = difyResponse.metadata.model_name;
  } else if (
    difyResponse.data &&
    difyResponse.data.outputs &&
    difyResponse.data.outputs.model_name
  ) {
    modelName = difyResponse.data.outputs.model_name;
  } else if (difyResponse.model_name) {
    modelName = difyResponse.model_name;
  }

  // Если usage не найден, возвращаем нулевые значения
  if (!usage || typeof usage !== 'object') {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      model: modelName,
    };
  }

  // Нормализация структуры usage
  // Dify может вернуть разные форматы:
  // 1. { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
  // 2. { prompt: 10, completion: 20, total: 30 }
  // 3. { tokens: 30 }

  const promptTokens =
    usage.prompt_tokens ||
    usage.prompt ||
    usage.input_tokens ||
    0;

  const completionTokens =
    usage.completion_tokens ||
    usage.completion ||
    usage.output_tokens ||
    0;

  const totalTokens =
    usage.total_tokens ||
    usage.total ||
    usage.tokens ||
    promptTokens + completionTokens;

  return {
    prompt_tokens: Number(promptTokens) || 0,
    completion_tokens: Number(completionTokens) || 0,
    total_tokens: Number(totalTokens) || 0,
    model: modelName || defaultModel,
  };
}

module.exports = {
  extractUsage,
};

