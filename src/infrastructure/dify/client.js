const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../../config');
const logger = require('../../utils/logger');
const { DifyApiError } = require('../../core/errors');
const { trimLogObject } = require('../../utils/logTrimmer');

// Создание агентов с Keep-Alive для переиспользования TCP-соединений
const agentOptions = { keepAlive: true, maxSockets: 100, maxFreeSockets: 10 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Создание настроенного инстанса Axios для Dify API
const difyClient = axios.create({
  baseURL: config.dify.url,
  timeout: 60000, // 60 секунд - LLM могут отвечать долго
  maxBodyLength: Infinity, // Убираем ограничение на размер тела запроса для больших файлов
  maxContentLength: Infinity, // Убираем ограничение на размер контента ответа
  httpAgent,
  httpsAgent,
});

// Request Interceptor - логирование исходящих запросов
difyClient.interceptors.request.use(
  (requestConfig) => {
    logger.debug('Dify API Request', {
      method: requestConfig.method?.toUpperCase(),
      url: requestConfig.url,
      // ВАЖНО: НЕ логируем headers и data, чтобы не утечь API-ключи
    });
    return requestConfig;
  },
  (error) => {
    logger.error('Dify API Request Error', { error: error.message });
    return Promise.reject(error);
  }
);

// Response Interceptor - обработка успешных ответов и ошибок
difyClient.interceptors.response.use(
  (response) => {
    const duration = response.config.metadata?.startTime
      ? Date.now() - response.config.metadata.startTime
      : null;

    logger.debug('Dify API Response Success', {
      status: response.status,
      url: response.config.url,
      duration: duration ? `${duration}ms` : null,
      data: trimLogObject(response.data),
    });

    return response;
  },
  (error) => {
    // Обработка ошибок от Dify API
    if (error.response) {
      // Сервер ответил с кодом ошибки
      const { status, data, config } = error.response;
      const difyCode = data?.code || null;
      const message = data?.message || error.message || 'Dify API Error';

      logger.error('Dify API Response Error', {
        statusCode: status,
        url: config?.url,
        difyCode,
        message,
        data: trimLogObject(data),
      });

      // Выбрасываем кастомную ошибку с деталями от Dify
      throw new DifyApiError(message, status, difyCode, config?.url);
    } else if (error.request) {
      // Запрос отправлен, но ответа не получено
      logger.error('Dify API Request Timeout/Network Error', {
        url: error.config?.url,
        message: error.message,
      });
      throw new DifyApiError(
        'Dify API request failed: no response received',
        null,
        null,
        error.config?.url
      );
    } else {
      // Ошибка при настройке запроса
      logger.error('Dify API Configuration Error', { message: error.message });
      throw error;
    }
  }
);

// Добавляем метаданные для измерения времени выполнения
difyClient.interceptors.request.use((config) => {
  config.metadata = { startTime: Date.now() };
  return config;
});

module.exports = difyClient;

