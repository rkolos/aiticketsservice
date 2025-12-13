/**
 * Ошибка API Dify с деталями HTTP ответа
 * Используется в: src/infrastructure/dify/client.js, src/utils/errorHandler.js
 */
class DifyApiError extends Error {
  constructor(message, statusCode, difyCode, url) {
    super(message);
    this.name = 'DifyApiError';
    this.statusCode = statusCode;
    this.difyCode = difyCode;
    this.url = url;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ошибка отсутствия базы знаний для организации
 * Используется в: src/services/OrganizationService.js, src/utils/errorHandler.js
 */
class KbNotFoundError extends Error {
  constructor(orgId) {
    super(`Knowledge base not found for organization: ${orgId}`);
    this.name = 'KbNotFoundError';
    this.orgId = orgId;
    this.code = 'KB_NOT_FOUND';

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  DifyApiError,
  KbNotFoundError,
};
