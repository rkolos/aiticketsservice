const logger = require('../utils/logger');

/**
 * Извлечение и нормализация данных о потреблении ресурсов из ответа Dify
 * @param {Object} difyResponse - Полный JSON-ответ от Dify API
 * @returns {Object} Объект с данными о токенах: { prompt_tokens, completion_tokens, total_tokens, model }
 */
function extractUsage(difyResponse) {
  // Обработка null и undefined
  if (!difyResponse || typeof difyResponse !== 'object') {
    logger.warn('extractUsage: invalid response, returning zero usage', {
      responseType: typeof difyResponse,
    });
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      model: null,
    };
  }

  let usage = null;
  let modelName = null;

  // Поиск usage в разных местах ответа Dify
  // 1. Стандартный путь для Chatflow
  if (difyResponse.metadata && difyResponse.metadata.usage) {
    usage = difyResponse.metadata.usage;
  }
  // 2. Альтернативный путь для Workflow (иногда встречается в outputs)
  else if (difyResponse.data && difyResponse.data.outputs && difyResponse.data.outputs.usage) {
    usage = difyResponse.data.outputs.usage;
  }
  // 3. Прямой путь (если usage на верхнем уровне)
  else if (difyResponse.usage) {
    usage = difyResponse.usage;
  }
  // 4. Для workflow ответов - проверяем metadata самого ответа
  else if (difyResponse.metadata && typeof difyResponse.metadata === 'object') {
    // Workflow может возвращать usage данные прямо в metadata
    if (difyResponse.metadata.prompt_tokens !== undefined || difyResponse.metadata.completion_tokens !== undefined) {
      usage = difyResponse.metadata;
    }
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

  const promptTokens = usage.prompt_tokens || usage.prompt || usage.input_tokens || 0;

  const completionTokens = usage.completion_tokens || usage.completion || usage.output_tokens || 0;

  const totalTokens =
    usage.total_tokens || usage.total || usage.tokens || promptTokens + completionTokens;

  return {
    prompt_tokens: Number(promptTokens) || 0,
    completion_tokens: Number(completionTokens) || 0,
    total_tokens: Number(totalTokens) || 0,
    model: modelName || null, // null если Dify не вернул модель
  };
}

/**
 * Суммирует usage данные из нескольких LLM вызовов
 * @param {Array} usages - Массив объектов usage { prompt_tokens, completion_tokens, total_tokens, model }
 * @returns {Object} Суммарный usage объект
 */
function accumulateUsage(usages) {
  if (!Array.isArray(usages) || usages.length === 0) {
    return {
      model: null,
      stages: [],
    };
  }

  const result = {
    model: usages.find(u => u?.model)?.model || null, // Первая не-null модель или null
    stages: [],
  };

  for (const usage of usages) {
    if (usage && typeof usage === 'object') {
      const promptTokens = Number(usage.prompt_tokens) || 0;
      const completionTokens = Number(usage.completion_tokens) || 0;

      // Пропускаем этапы с нулевыми токенами (например, если workflow не возвращает usage)
      if (promptTokens === 0 && completionTokens === 0) {
        continue;
      }

      // Сохраняем информацию о каждом этапе
      result.stages.push({
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        ...(usage.model && { model: usage.model }), // Включаем модель только если известна
      });
    }
  }

  return result;
}

module.exports = {
  extractUsage,
  accumulateUsage,
};
