const FileService = require('../../src/services/FileService');
const {
  FileServiceError,
  FileNotFoundError,
  ConnectionTimeoutError,
  IdleTimeoutError,
} = require('../../src/services/FileService');
const axios = require('axios');

// Мокаем axios
jest.mock('axios');

// Мокаем config
jest.mock('../../src/config', () => ({
  fileService: {
    connectionTimeout: 30000,
    idleTimeout: 100, // Используем короткий таймаут для тестов (100ms)
  },
}));

describe('FileService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('downloadStream', () => {
    test('должен успешно скачать файл с content-length', async () => {
      const url = 'https://example.com/file.pdf';
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            // Симулируем получение данных
            setTimeout(() => handler(Buffer.from('test data')), 0);
          }
          if (event === 'end') {
            setTimeout(() => handler(), 100);
          }
          return mockStream;
        }),
        destroyed: false,
        destroy: jest.fn(),
      };

      axios.mockResolvedValue({
        status: 200,
        headers: {
          'content-length': '1024',
        },
        data: mockStream,
      });

      const result = await FileService.downloadStream(url);

      expect(result.stream).toBe(mockStream);
      expect(result.size).toBe(1024);
      expect(axios).toHaveBeenCalledWith({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 30000,
      });
    });

    test('должен успешно скачать файл без content-length', async () => {
      const url = 'https://example.com/file.pdf';
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            setTimeout(() => handler(Buffer.from('test data')), 0);
          }
          if (event === 'end') {
            setTimeout(() => handler(), 100);
          }
          return mockStream;
        }),
        destroyed: false,
        destroy: jest.fn(),
      };

      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: mockStream,
      });

      const result = await FileService.downloadStream(url);

      expect(result.stream).toBe(mockStream);
      expect(result.size).toBeNull();
    });

    test('должен выбросить FileNotFoundError при 404', async () => {
      const url = 'https://example.com/notfound.pdf';

      axios.mockRejectedValue({
        response: {
          status: 404,
          statusText: 'Not Found',
        },
      });

      await expect(FileService.downloadStream(url)).rejects.toThrow(FileNotFoundError);
      await expect(FileService.downloadStream(url)).rejects.toThrow('File not found');
    });

    test('должен выбросить ConnectionTimeoutError при таймауте подключения', async () => {
      const url = 'https://example.com/file.pdf';

      axios.mockRejectedValue({
        code: 'ETIMEDOUT',
        message: 'Connection timeout',
      });

      await expect(FileService.downloadStream(url)).rejects.toThrow(ConnectionTimeoutError);
      await expect(FileService.downloadStream(url)).rejects.toThrow('Connection timeout');
    });

    test('должен выбросить ConnectionTimeoutError при ECONNABORTED', async () => {
      const url = 'https://example.com/file.pdf';

      axios.mockRejectedValue({
        code: 'ECONNABORTED',
        message: 'Connection aborted',
      });

      await expect(FileService.downloadStream(url)).rejects.toThrow(ConnectionTimeoutError);
    });

    test('должен выбросить FileServiceError при других HTTP ошибках', async () => {
      const url = 'https://example.com/file.pdf';

      axios.mockRejectedValue({
        response: {
          status: 500,
          statusText: 'Internal Server Error',
        },
      });

      await expect(FileService.downloadStream(url)).rejects.toThrow(FileServiceError);
      await expect(FileService.downloadStream(url)).rejects.toThrow('Download failed: 500');
    });

    test('должен выбросить FileServiceError при отсутствии URL', async () => {
      await expect(FileService.downloadStream(null)).rejects.toThrow(FileServiceError);
      await expect(FileService.downloadStream(null)).rejects.toThrow('URL is required');
    });
  });

  describe('Idle Timeout', () => {
    test('должен закрыть стрим при idle timeout', async () => {
      jest.useRealTimers(); // Используем реальные таймеры для этого теста

      const url = 'https://example.com/file.pdf';
      let errorEmitted = false;
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (!mockStream._listeners) {
            mockStream._listeners = {};
          }
          mockStream._listeners[event] = handler;
          return mockStream;
        }),
        emit: jest.fn((event, error) => {
          if (event === 'error' && mockStream._listeners && mockStream._listeners.error) {
            errorEmitted = true;
            mockStream._listeners.error(error);
          }
        }),
        destroyed: false,
        destroy: jest.fn((error) => {
          mockStream.destroyed = true;
          // Эмулируем emit error при destroy
          if (error && mockStream.emit) {
            mockStream.emit('error', error);
          }
        }),
      };

      axios.mockResolvedValue({
        status: 200,
        headers: {
          'content-length': '1024',
        },
        data: mockStream,
      });

      // Запускаем downloadStream, но не отправляем данные
      const result = await FileService.downloadStream(url);

      expect(result.stream).toBe(mockStream);
      expect(result.size).toBe(1024);

      // Ждем, пока стрим будет настроен
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Ждем, пока сработает idle timeout (больше 100ms)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Проверяем, что стрим был разрушен из-за idle timeout
      expect(mockStream.destroy).toHaveBeenCalled();
      expect(mockStream.destroyed).toBe(true);

      // Проверяем, что была вызвана ошибка IdleTimeoutError
      const destroyCalls = mockStream.destroy.mock.calls;
      expect(destroyCalls.length).toBeGreaterThan(0);
      const lastCall = destroyCalls[destroyCalls.length - 1];
      expect(lastCall[0]).toBeInstanceOf(IdleTimeoutError);

      jest.useFakeTimers(); // Возвращаем fake timers для других тестов
    });

    test('должен сбросить idle timeout при получении данных', async () => {
      jest.useRealTimers();

      const url = 'https://example.com/file.pdf';
      let dataHandler = null;
      let endHandler = null;
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            dataHandler = handler;
          }
          if (event === 'end') {
            endHandler = handler;
          }
          return mockStream;
        }),
        destroyed: false,
        destroy: jest.fn(),
      };

      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: mockStream,
      });

      const promise = FileService.downloadStream(url);

      // Ждем, пока стрим будет настроен
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Проходим 50ms (меньше чем timeout)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Отправляем данные - таймер должен сброситься
      if (dataHandler) {
        dataHandler(Buffer.from('chunk1'));
      }

      // Проходим еще 50ms - таймер должен быть сброшен, ошибки не должно быть
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Завершаем стрим
      if (endHandler) {
        endHandler();
      }

      const result = await promise;

      expect(result.stream).toBe(mockStream);
      expect(mockStream.destroy).not.toHaveBeenCalled();

      jest.useFakeTimers();
    });

    test('должен очистить таймер при завершении стрима', async () => {
      jest.useRealTimers();

      const url = 'https://example.com/file.pdf';
      let dataHandler = null;
      let endHandler = null;
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            dataHandler = handler;
          }
          if (event === 'end') {
            endHandler = handler;
          }
          return mockStream;
        }),
        destroyed: false,
        destroy: jest.fn(),
      };

      axios.mockResolvedValue({
        status: 200,
        headers: {},
        data: mockStream,
      });

      const promise = FileService.downloadStream(url);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Отправляем данные
      if (dataHandler) {
        dataHandler(Buffer.from('chunk'));
      }

      // Завершаем стрим сразу
      if (endHandler) {
        endHandler();
      }

      await promise;

      // Проходим время - ошибки не должно быть, так как стрим завершен
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(mockStream.destroy).not.toHaveBeenCalled();

      jest.useFakeTimers();
    });
  });

  describe('Error classes', () => {
    test('FileServiceError должен иметь правильную структуру', () => {
      const error = new FileServiceError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('FileServiceError');
    });

    test('FileNotFoundError должен иметь правильную структуру', () => {
      const url = 'https://example.com/file.pdf';
      const error = new FileNotFoundError(url);
      expect(error.message).toContain('File not found');
      expect(error.code).toBe('FILE_NOT_FOUND');
      expect(error.url).toBe(url);
      expect(error.name).toBe('FileNotFoundError');
    });

    test('ConnectionTimeoutError должен иметь правильную структуру', () => {
      const url = 'https://example.com/file.pdf';
      const error = new ConnectionTimeoutError(url);
      expect(error.message).toContain('Connection timeout');
      expect(error.code).toBe('CONNECTION_TIMEOUT');
      expect(error.url).toBe(url);
      expect(error.name).toBe('ConnectionTimeoutError');
    });

    test('IdleTimeoutError должен иметь правильную структуру', () => {
      const url = 'https://example.com/file.pdf';
      const timeoutMs = 60000;
      const error = new IdleTimeoutError(url, timeoutMs);
      expect(error.message).toContain('Stream idle timeout');
      expect(error.code).toBe('IDLE_TIMEOUT');
      expect(error.url).toBe(url);
      expect(error.timeoutMs).toBe(timeoutMs);
      expect(error.name).toBe('IdleTimeoutError');
    });
  });
});

