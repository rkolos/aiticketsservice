const logger = require('./logger');

/**
 * Форматирование истории тикета в структурированный Markdown формат
 * @param {Array|string|null|undefined} history - История в виде массива сообщений или Markdown строки
 * @returns {string} Отформатированная история в Markdown
 */
function formatTicketHistory(history) {
  // Обработка null и undefined
  if (history === null || history === undefined) {
    logger.warn('formatTicketHistory: history is null or undefined, returning empty string');
    return '';
  }

  // Если уже строка Markdown, валидируем и возвращаем
  if (typeof history === 'string') {
    return validateAndNormalizeMarkdown(history);
  }

  // Если массив сообщений
  if (Array.isArray(history)) {
    if (history.length === 0) {
      return '';
    }

    return formatArrayToMarkdown(history);
  }

  // Некорректный формат
  logger.warn('formatTicketHistory: invalid format', {
    type: typeof history,
    isArray: Array.isArray(history),
  });
  return '';
}

/**
 * Преобразование массива сообщений в Markdown
 * @param {Array} messages - Массив сообщений [{ role: 'user'|'assistant', content: string }, ...]
 * @returns {string} Markdown строка
 */
function formatArrayToMarkdown(messages) {
  const formattedLines = [];

  for (const message of messages) {
    // Проверка структуры сообщения
    if (!message || typeof message !== 'object') {
      logger.warn('formatArrayToMarkdown: invalid message object', { message });
      continue;
    }

    const { role, content } = message;

    // Проверка обязательных полей
    if (!role || typeof role !== 'string') {
      logger.warn('formatArrayToMarkdown: missing or invalid role', { message });
      continue;
    }

    if (content === null || content === undefined) {
      logger.warn('formatArrayToMarkdown: missing content', { role });
      continue;
    }

    // Нормализация роли
    const normalizedRole =
      role.toLowerCase() === 'user' || role.toLowerCase() === 'assistant'
        ? role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()
        : role;

    // Форматирование: "Role: content"
    formattedLines.push(`${normalizedRole}: ${String(content).trim()}`);
    formattedLines.push(''); // Пустая строка между сообщениями
  }

  // Убираем последнюю пустую строку
  if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1] === '') {
    formattedLines.pop();
  }

  return formattedLines.join('\n');
}

/**
 * Валидация и нормализация уже отформатированного Markdown
 * @param {string} markdown - Markdown строка
 * @returns {string} Нормализованная Markdown строка
 */
function validateAndNormalizeMarkdown(markdown) {
  if (typeof markdown !== 'string') {
    logger.warn('validateAndNormalizeMarkdown: input is not a string');
    return '';
  }

  // Базовая валидация структуры (должны быть строки вида "Role: content")
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);

  // Если нет строк, возвращаем пустую строку
  if (lines.length === 0) {
    return '';
  }

  // Проверяем, что есть хотя бы одна строка с паттерном "Role: content"
  const rolePattern = /^(User|Assistant|user|assistant):\s+.+$/;
  const hasValidStructure = lines.some((line) => rolePattern.test(line.trim()));

  if (!hasValidStructure) {
    logger.warn('validateAndNormalizeMarkdown: markdown does not match expected structure');
    // Возвращаем как есть, возможно это уже валидный формат, который мы не распознали
    return markdown.trim();
  }

  // Нормализуем форматирование: убираем лишние пробелы, добавляем пустые строки между сообщениями
  const normalizedLines = [];
  let previousWasRole = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const isRoleLine = rolePattern.test(trimmed);

    if (isRoleLine) {
      // Если предыдущая строка была ролью, добавляем пустую строку
      if (previousWasRole) {
        normalizedLines.push('');
      }
      normalizedLines.push(trimmed);
      previousWasRole = true;
    } else {
      // Продолжение контента предыдущего сообщения
      normalizedLines.push(trimmed);
      previousWasRole = false;
    }
  }

  return normalizedLines.join('\n');
}

module.exports = {
  formatTicketHistory,
};
