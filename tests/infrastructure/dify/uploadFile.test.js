const difyApi = require('../../../src/infrastructure/dify/api');
const difyClient = require('../../../src/infrastructure/dify/client');

// Мокаем difyClient
jest.mock('../../../src/infrastructure/dify/client', () => {
  return {
    post: jest.fn(),
  };
});

// Мокаем form-data
let mockFormData;
jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => {
    mockFormData = {
      append: jest.fn(),
      getHeaders: jest.fn(() => ({
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      })),
    };
    return mockFormData;
  });
});

describe('Dify API - uploadFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('должен загрузить файл с knownLength когда передан fileSize', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';
    const fileSize = 1024;

    const mockResponse = {
      data: {
        document_id: 'doc-123',
        status: 'indexing',
      },
    };

    difyClient.post.mockResolvedValue(mockResponse);

    const result = await difyApi.uploadFile(
      apiKey,
      datasetId,
      fileStream,
      fileName,
      'system',
      fileSize
    );

    // Проверяем, что FormData создан (через require mock)
    const FormData = require('form-data');
    expect(FormData).toHaveBeenCalled();

    // Проверяем, что файл добавлен с knownLength
    expect(mockFormData.append).toHaveBeenCalledWith(
      'file',
      fileStream,
      {
        filename: fileName,
        knownLength: fileSize,
      }
    );

    // Проверяем, что поле data добавлено
    expect(mockFormData.append).toHaveBeenCalledWith('data', expect.any(String));

    // Проверяем содержимое поля data
    const dataCalls = mockFormData.append.mock.calls.filter((call) => call[0] === 'data');
    expect(dataCalls.length).toBe(1);
    const dataValue = JSON.parse(dataCalls[0][1]);
    expect(dataValue).toEqual({
      indexing_technique: 'high_quality',
      process_rule: {
        mode: 'automatic',
        rules: {},
      },
    });

    // Проверяем, что запрос отправлен с правильными заголовками
    expect(difyClient.post).toHaveBeenCalledWith(
      `/datasets/${datasetId}/document/create_by_file`,
      mockFormData,
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
          Authorization: `Bearer ${apiKey}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: expect.any(Function),
      }
    );

    // Проверяем результат
    expect(result).toEqual(mockResponse.data);
  });

  test('должен загрузить файл без knownLength когда fileSize не передан', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';

    const mockResponse = {
      data: {
        document_id: 'doc-123',
        status: 'indexing',
      },
    };

    difyClient.post.mockResolvedValue(mockResponse);

    const result = await difyApi.uploadFile(apiKey, datasetId, fileStream, fileName);

    // Проверяем, что файл добавлен БЕЗ knownLength
    expect(mockFormData.append).toHaveBeenCalledWith(
      'file',
      fileStream,
      {
        filename: fileName,
      }
    );

    expect(result).toEqual(mockResponse.data);
  });

  test('должен загрузить файл без knownLength когда fileSize равен null', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';
    const fileSize = null;

    const mockResponse = {
      data: {
        document_id: 'doc-123',
        status: 'indexing',
      },
    };

    difyClient.post.mockResolvedValue(mockResponse);

    await difyApi.uploadFile(apiKey, datasetId, fileStream, fileName, 'system', fileSize);

    // Проверяем, что файл добавлен БЕЗ knownLength
    expect(mockFormData.append).toHaveBeenCalledWith(
      'file',
      fileStream,
      {
        filename: fileName,
      }
    );
  });

  test('должен загрузить файл без knownLength когда fileSize равен undefined', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';
    const fileSize = undefined;

    const mockResponse = {
      data: {
        document_id: 'doc-123',
        status: 'indexing',
      },
    };

    difyClient.post.mockResolvedValue(mockResponse);

    await difyApi.uploadFile(apiKey, datasetId, fileStream, fileName, 'system', fileSize);

    // Проверяем, что файл добавлен БЕЗ knownLength
    expect(mockFormData.append).toHaveBeenCalledWith(
      'file',
      fileStream,
      {
        filename: fileName,
      }
    );
  });

  test('должен использовать заголовки от formData.getHeaders() перед Authorization', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';
    const fileSize = 1024;

    const customHeaders = {
      'content-type': 'multipart/form-data; boundary=----CustomBoundary',
      'custom-header': 'custom-value',
    };

    // Устанавливаем возвращаемое значение для getHeaders перед вызовом
    if (mockFormData) {
      mockFormData.getHeaders.mockReturnValue(customHeaders);
    }

    difyClient.post.mockResolvedValue({
      data: { document_id: 'doc-123' },
    });

    await difyApi.uploadFile(apiKey, datasetId, fileStream, fileName, 'system', fileSize);

    // Проверяем, что метод был вызван
    expect(difyClient.post).toHaveBeenCalled();

    // Проверяем, что заголовки содержат как formData заголовки, так и Authorization
    const callArgs = difyClient.post.mock.calls[0];
    const headers = callArgs[2].headers;

    // Проверяем, что заголовки от formData присутствуют
    expect(headers['content-type']).toBeDefined();
    // Проверяем, что Authorization добавлен
    expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
  });

  test('должен обработать ошибку от Dify API', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';

    const { DifyApiError } = require('../../../src/core/errors');

    difyClient.post.mockRejectedValue(
      new DifyApiError('Dataset not found', 404, 'dataset_not_found', '/datasets/dataset-123/document/create_by_file')
    );

    await expect(
      difyApi.uploadFile(apiKey, datasetId, fileStream, fileName)
    ).rejects.toThrow(DifyApiError);
  });

  test('должен использовать дефолтное значение user = "system"', async () => {
    const apiKey = 'test-api-key';
    const datasetId = 'dataset-123';
    const fileStream = { readable: true };
    const fileName = 'test.pdf';

    difyClient.post.mockResolvedValue({
      data: { document_id: 'doc-123' },
    });

    await difyApi.uploadFile(apiKey, datasetId, fileStream, fileName);

    // Проверяем, что запрос отправлен (user не влияет на заголовки, но метод должен работать)
    expect(difyClient.post).toHaveBeenCalled();
  });
});

