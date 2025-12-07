const logger = require('./logger');

/**
 * Очистка JSON ответов от Markdown оберток, которые могут добавлять LLM
 * @param {string} text - Текст с возможными Markdown обертками
 * @returns {string} Очищенный JSON
 * @throws {Error} Если JSON некорректен после очистки
 */
function cleanLlmJson(text) {
  if (typeof text !== 'string') {
    throw new Error('cleanLlmJson: input must be a string');
  }

  let cleaned = text.trim();

  // Удаление Markdown обертки ```json ... ``` (с учетом пробелов)
  cleaned = cleaned.replace(/^```\s*json\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?\s*```\s*$/, '');

  // Удаление Markdown обертки ``` ... ``` (без указания языка, если еще не удалено)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*\n?/, '');
    cleaned = cleaned.replace(/\n?\s*```\s*$/, '');
  }

  // Удаление лишних пробелов и переносов строк в начале и конце
  cleaned = cleaned.trim();

  // Валидация JSON структуры
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch (error) {
    logger.error('cleanLlmJson: invalid JSON after cleaning', {
      originalLength: text.length,
      cleanedLength: cleaned.length,
      error: error.message,
    });
    throw new Error(`Invalid JSON after cleaning: ${error.message}`);
  }
}

module.exports = {
  cleanLlmJson,
};
