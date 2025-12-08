const { normalizeError, createErrorPayload } = require('../../../src/utils/errorHandler');
const { DifyApiError, KbNotFoundError } = require('../../../src/core/errors');

describe('errorHandler', () => {
  describe('normalizeError', () => {
    it('должен обрабатывать null и undefined', () => {
      expect(normalizeError(null)).toEqual({
        errorCode: 'INTERNAL_ERROR',
        message: 'Unknown system error',
      });

      expect(normalizeError(undefined)).toEqual({
        errorCode: 'INTERNAL_ERROR',
        message: 'Unknown system error',
      });
    });

    it('должен обрабатывать DifyApiError с difyCode', () => {
      const error = new DifyApiError('Dataset not found', 404, 'dataset_not_found', '/datasets/123');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('dataset_not_found');
      expect(result.message).toBe('Dataset not found');
      expect(result.originalError).toBe(error);
    });

    it('должен обрабатывать DifyApiError с 404 статусом', () => {
      const error = new DifyApiError('Not found', 404, null, '/datasets/123');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('DIFY_API_ERROR');
      expect(result.message).toBe('Not found');
    });

    it('должен обрабатывать DifyApiError без difyCode', () => {
      const error = new DifyApiError('API error', 500, null, '/workflows/run');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('DIFY_API_ERROR');
      expect(result.message).toBe('API error');
    });

    it('должен обрабатывать KbNotFoundError', () => {
      const error = new KbNotFoundError('org-123');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('KB_NOT_FOUND');
      expect(result.message).toBe('Knowledge base not initialized');
      expect(result.originalError).toBe(error);
    });

    it('должен обрабатывать AxiosError с ECONNREFUSED', () => {
      const error = {
        isAxiosError: true,
        code: 'ECONNREFUSED',
        message: 'Connection refused',
        request: {},
      };

      const result = normalizeError(error);

      expect(result.errorCode).toBe('NETWORK_ERROR');
      expect(result.message).toBe('Failed to connect to AI provider');
      expect(result.originalError).toBe(error);
    });

    it('должен обрабатывать AxiosError с ETIMEDOUT', () => {
      const error = {
        isAxiosError: true,
        code: 'ETIMEDOUT',
        message: 'Timeout',
        request: {},
      };

      const result = normalizeError(error);

      expect(result.errorCode).toBe('TIMEOUT');
      expect(result.message).toBe('Failed to connect to AI provider');
    });

    it('должен обрабатывать AxiosError с ECONNABORTED', () => {
      const error = {
        isAxiosError: true,
        code: 'ECONNABORTED',
        message: 'Connection aborted',
        request: {},
      };

      const result = normalizeError(error);

      expect(result.errorCode).toBe('TIMEOUT');
      expect(result.message).toBe('Failed to connect to AI provider');
    });

    it('должен обрабатывать сетевую ошибку без isAxiosError, но с request', () => {
      const error = {
        request: {},
        message: 'Network error',
      };

      const result = normalizeError(error);

      expect(result.errorCode).toBe('NETWORK_ERROR');
      expect(result.message).toBe('Failed to connect to AI provider');
    });

    it('должен обрабатывать SyntaxError (ошибка парсинга JSON)', () => {
      const error = new SyntaxError('Unexpected token } in JSON');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('LLM_OUTPUT_PARSE_ERROR');
      expect(result.message).toBe('Failed to process AI response');
      expect(result.originalError).toBe(error);
    });

    it('должен обрабатывать ошибку с name === SyntaxError', () => {
      const error = {
        name: 'SyntaxError',
        message: 'Invalid JSON',
      };

      const result = normalizeError(error);

      expect(result.errorCode).toBe('LLM_OUTPUT_PARSE_ERROR');
      expect(result.message).toBe('Failed to process AI response');
    });

    it('должен обрабатывать обычные ошибки', () => {
      const error = new Error('Something went wrong');
      const result = normalizeError(error);

      expect(result.errorCode).toBe('INTERNAL_ERROR');
      expect(result.message).toBe('Something went wrong');
      expect(result.originalError).toBe(error);
    });

    it('должен обрабатывать ошибки без message', () => {
      const error = new Error();
      const result = normalizeError(error);

      expect(result.errorCode).toBe('INTERNAL_ERROR');
      expect(result.message).toBe('Unknown system error');
    });
  });

  describe('createErrorPayload', () => {
    it('должен создавать пейлоад ошибки с meta', () => {
      const error = new Error('Test error');
      const meta = { orgId: 'org-123', userId: 'user-456' };

      const result = createErrorPayload(error, meta);

      expect(result).toEqual({
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        message: 'Test error',
        meta,
      });
    });

    it('должен создавать пейлоад для DifyApiError', () => {
      const error = new DifyApiError('API error', 500, 'provider_quota_exceeded', '/workflows/run');
      const meta = { orgId: 'org-123' };

      const result = createErrorPayload(error, meta);

      expect(result.status).toBe('error');
      expect(result.errorCode).toBe('provider_quota_exceeded');
      expect(result.message).toBe('API error');
      expect(result.meta).toBe(meta);
    });

    it('должен создавать пейлоад для KbNotFoundError', () => {
      const error = new KbNotFoundError('org-123');
      const meta = { orgId: 'org-123' };

      const result = createErrorPayload(error, meta);

      expect(result.status).toBe('error');
      expect(result.errorCode).toBe('KB_NOT_FOUND');
      expect(result.message).toBe('Knowledge base not initialized');
      expect(result.meta).toBe(meta);
    });

    it('должен создавать пейлоад с пустым meta, если не передан', () => {
      const error = new Error('Test error');
      const result = createErrorPayload(error);

      expect(result.meta).toEqual({});
    });
  });
});

