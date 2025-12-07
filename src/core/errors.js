/**
 * Кастомные классы ошибок для приложения
 */

/**
 * Ошибка API Dify
 */
class DifyApiError extends Error {
  constructor(message, statusCode, difyCode, url) {
    super(message);
    this.name = 'DifyApiError';
    this.statusCode = statusCode;
    this.difyCode = difyCode;
    this.url = url;

    // Сохраняет правильный стек для ошибки
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  DifyApiError,
};

