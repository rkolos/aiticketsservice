const { encoding_for_model } = require('tiktoken');
const logger = require('./logger');

// Модели OpenAI, поддерживаемые tiktoken
const SUPPORTED_MODELS = [
  'gpt-4',
  'gpt-4-32k',
  'gpt-4-turbo',
  'gpt-4-turbo-preview',
  'gpt-4o',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-16k',
];

/**
 * Подсчет токенов в тексте
 * @param {string|null|undefined} text - Текст для подсчета
 * @param {string} modelName - Имя модели (например, 'gpt-4', 'gpt-3.5-turbo')
 * @returns {number} Количество токенов
 */
function countTokens(text, modelName = 'gpt-4') {
  // Обработка edge cases
  if (text === null || text === undefined) {
    return 0;
  }

  if (typeof text !== 'string') {
    logger.warn('countTokens: text is not a string, converting to string', {
      type: typeof text,
    });
    text = String(text);
  }

  if (text.length === 0) {
    return 0;
  }

  // Используем tiktoken для моделей OpenAI
  if (SUPPORTED_MODELS.includes(modelName)) {
    try {
      const encoding = encoding_for_model(modelName);
      const tokens = encoding.encode(text);
      encoding.free(); // Освобождаем память
      return tokens.length;
    } catch (error) {
      logger.warn('Error using tiktoken, falling back to estimation', {
        modelName,
        error: error.message,
      });
      // Fallback на приблизительный подсчет
      return estimateTokensFallback(text);
    }
  }

  // Fallback для других моделей: приблизительный подсчет
  return estimateTokensFallback(text);
}

/**
 * Приблизительный подсчет токенов (fallback для моделей, не поддерживаемых tiktoken)
 * Использует эмпирическое правило: ~4 символа = 1 токен для английского,
 * ~2 символа = 1 токен для русского
 * @param {string} text - Текст для подсчета
 * @returns {number} Приблизительное количество токенов
 */
function estimateTokensFallback(text) {
  // Подсчитываем количество русских и английских символов
  const cyrillicChars = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  const otherChars = text.length - cyrillicChars - latinChars;

  // Эмпирическое правило: русский ~2 символа на токен, английский ~4 символа на токен
  const russianTokens = Math.ceil(cyrillicChars / 2);
  const englishTokens = Math.ceil(latinChars / 4);
  const otherTokens = Math.ceil(otherChars / 3); // Среднее значение

  return russianTokens + englishTokens + otherTokens;
}

/**
 * Подсчет суммарного количества токенов для всех компонентов запроса
 * @param {string|null|undefined} context - Контекст из базы знаний
 * @param {string|null|undefined} history - История переписки
 * @param {string|null|undefined} query - Текущий запрос пользователя
 * @param {string} modelName - Имя модели
 * @returns {Object} Объект с разбивкой по компонентам: { context, history, query, total }
 */
function estimateTotalTokens(context, history, query, modelName = 'gpt-4') {
  const contextTokens = countTokens(context, modelName);
  const historyTokens = countTokens(history, modelName);
  const queryTokens = countTokens(query, modelName);

  // Учитываем системный промпт (приблизительно 100 токенов)
  const systemPromptTokens = 100;

  const total = contextTokens + historyTokens + queryTokens + systemPromptTokens;

  return {
    context: contextTokens,
    history: historyTokens,
    query: queryTokens,
    systemPrompt: systemPromptTokens,
    total,
  };
}

module.exports = {
  countTokens,
  estimateTotalTokens,
};
