const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Базовый класс ошибки FileService
 */
class FileServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FileServiceError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ошибка: файл не найден (404)
 */
class FileNotFoundError extends FileServiceError {
  constructor(url) {
    super(`File not found: ${url}`, 'FILE_NOT_FOUND');
    this.name = 'FileNotFoundError';
    this.url = url;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ошибка: таймаут подключения
 */
class ConnectionTimeoutError extends FileServiceError {
  constructor(url) {
    super(`Connection timeout: ${url}`, 'CONNECTION_TIMEOUT');
    this.name = 'ConnectionTimeoutError';
    this.url = url;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ошибка: таймаут на отсутствие данных (idle timeout)
 */
class IdleTimeoutError extends FileServiceError {
  constructor(url, timeoutMs) {
    super(`Stream idle timeout: no data received for ${timeoutMs}ms: ${url}`, 'IDLE_TIMEOUT');
    this.name = 'IdleTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Сервис для работы с файлами (скачивание)
 */
class FileService {
  /**
   * Скачать файл по URL и вернуть стрим с настройкой таймаутов
   * @param {string} url - URL файла для скачивания
   * @returns {Promise<{stream: ReadStream, size: number | null}>} Объект с потоком и размером файла
   * @throws {FileNotFoundError} Если файл не найден (404)
   * @throws {ConnectionTimeoutError} Если превышен таймаут подключения
   * @throws {IdleTimeoutError} Если стрим завис (нет данных)
   * @throws {FileServiceError} При других ошибках скачивания
   */
  async downloadStream(url) {
    if (!url) {
      throw new FileServiceError('URL is required', 'DOWNLOAD_ERROR');
    }

    const connectionTimeout = config.fileService.connectionTimeout;
    const idleTimeout = config.fileService.idleTimeout;

    logger.debug('FileService: starting download', {
      url,
      connectionTimeout,
      idleTimeout,
    });

    try {
      // Создать axios запрос с настройками
      const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: connectionTimeout,
      });

      // Извлечь content-length из заголовков
      const contentLength = response.headers['content-length'];
      const size = contentLength ? parseInt(contentLength, 10) : null;

      logger.debug('FileService: response received', {
        url,
        size,
        statusCode: response.status,
      });

      // Получить стрим
      const stream = response.data;

      // Настроить idle timeout для стрима
      let lastDataTime = Date.now();
      let idleTimer = null;
      let streamDestroyed = false;

      // Функция для уничтожения стрима
      const destroyStream = (error) => {
        if (streamDestroyed) {
          return;
        }
        streamDestroyed = true;

        if (idleTimer) {
          // eslint-disable-next-line no-undef
          clearTimeout(idleTimer);
          idleTimer = null;
        }

        try {
          if (!stream.destroyed) {
            stream.destroy(error);
          }
        } catch (destroyError) {
          // Игнорируем ошибки при закрытии уже закрытого стрима
          logger.debug('FileService: error destroying stream', {
            url,
            error: destroyError.message,
          });
        }
      };

      // Установить начальный таймер для проверки idle timeout
      // eslint-disable-next-line no-undef
      idleTimer = setTimeout(() => {
        const timeSinceLastData = Date.now() - lastDataTime;
        if (timeSinceLastData >= idleTimeout && !streamDestroyed) {
          const error = new IdleTimeoutError(url, idleTimeout);
          logger.warn('FileService: idle timeout detected', {
            url,
            timeSinceLastData,
            idleTimeout,
          });
          destroyStream(error);
          // Пробрасываем ошибку через событие error
          stream.emit('error', error);
        }
      }, idleTimeout);

      // Обработчик получения данных - сброс таймера
      stream.on('data', () => {
        lastDataTime = Date.now();

        // Сбросить существующий таймер
        if (idleTimer) {
          // eslint-disable-next-line no-undef
          clearTimeout(idleTimer);
        }

        // Установить новый таймер для проверки idle timeout
        // eslint-disable-next-line no-undef
        idleTimer = setTimeout(() => {
          const timeSinceLastData = Date.now() - lastDataTime;
          if (timeSinceLastData >= idleTimeout && !streamDestroyed) {
            const error = new IdleTimeoutError(url, idleTimeout);
            logger.warn('FileService: idle timeout detected', {
              url,
              timeSinceLastData,
              idleTimeout,
            });
            destroyStream(error);
            // Пробрасываем ошибку через событие error
            stream.emit('error', error);
          }
        }, idleTimeout);
      });

      // Обработчик завершения стрима
      stream.on('end', () => {
        logger.debug('FileService: stream ended', { url });
        if (idleTimer) {
          // eslint-disable-next-line no-undef
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      });

      // Обработчик ошибок стрима
      stream.on('error', (streamError) => {
        logger.error('FileService: stream error', {
          url,
          error: streamError.message,
        });
        if (idleTimer) {
          // eslint-disable-next-line no-undef
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        // Не уничтожаем стрим здесь, так как ошибка уже произошла
      });

      // Обработчик закрытия стрима
      stream.on('close', () => {
        if (idleTimer) {
          // eslint-disable-next-line no-undef
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      });

      return {
        stream,
        size,
      };
    } catch (error) {
      logger.error('FileService: download error', {
        url,
        error: error.message,
        code: error.code,
        status: error.response?.status,
      });

      // Обработка специфичных ошибок
      if (error.response) {
        // HTTP ошибки
        if (error.response.status === 404) {
          throw new FileNotFoundError(url);
        }

        // Другие HTTP ошибки
        throw new FileServiceError(
          `Download failed: ${error.response.status} ${error.response.statusText}`,
          'DOWNLOAD_ERROR'
        );
      }

      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new ConnectionTimeoutError(url);
      }

      if (error instanceof IdleTimeoutError) {
        throw error;
      }

      // Общая ошибка
      throw new FileServiceError(`Download error: ${error.message}`, 'DOWNLOAD_ERROR');
    }
  }
}

module.exports = new FileService();
module.exports.FileServiceError = FileServiceError;
module.exports.FileNotFoundError = FileNotFoundError;
module.exports.ConnectionTimeoutError = ConnectionTimeoutError;
module.exports.IdleTimeoutError = IdleTimeoutError;

