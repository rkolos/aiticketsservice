const difyApi = require('../../../src/infrastructure/dify/api');
const FileService = require('../../../src/services/FileService');
const fs = require('fs');
const path = require('path');
const config = require('../../../src/config');

/**
 * Интеграционный тест для uploadFile
 * Тестирует реальную загрузку файлов в Dify API
 */
describe('Dify API - uploadFile Integration', () => {
  const adminKey = config.dify.keys.admin;
  let testDatasetId = null;
  let isDifyAvailable = false;

  beforeAll(async () => {
    // Проверяем доступность Dify API
    try {
      await difyApi.listDatasets(adminKey, 1, 1);
      isDifyAvailable = true;
    } catch (error) {
      // Dify API недоступен - пропускаем интеграционные тесты
      isDifyAvailable = false;
      console.warn('Dify API недоступен, интеграционные тесты будут пропущены:', error.message);
      return;
    }

    try {
      // Создаем тестовый датасет для интеграционных тестов
      const datasets = await difyApi.listDatasets(adminKey, 1, 100);
      const testDataset = datasets.data.find((ds) => ds.name === 'TEST_UPLOAD_FILE_DATASET');

      if (testDataset) {
        testDatasetId = testDataset.id;
      } else {
        // Создаем новый датасет для тестов
        const newDataset = await difyApi.createDataset(adminKey, 'TEST_UPLOAD_FILE_DATASET');
        testDatasetId = newDataset.id;
      }
    } catch (error) {
      throw new Error(`Не удалось создать/найти тестовый датасет: ${error.message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (testDatasetId) {
      try {
        // Удаляем тестовый датасет
        await difyApi.deleteDataset(adminKey, testDatasetId);
      } catch (error) {
        // Игнорируем ошибки удаления - это не критично для тестов
        console.warn('Не удалось удалить тестовый датасет:', error.message);
      }
    }
  }, 30000);

  test('должен загрузить реальный файл в Dify с knownLength', async () => {
    if (!isDifyAvailable) {
      console.log('Пропуск теста: Dify API недоступен');
      return;
    }
    expect(testDatasetId).toBeTruthy();

    // Создаем временный тестовый файл
    const testContent = 'Test file content for upload';
    const tempFilePath = path.join(__dirname, 'temp-test-file.txt');
    fs.writeFileSync(tempFilePath, testContent);

    try {
      // Создаем поток из файла
      const fileStream = fs.createReadStream(tempFilePath);
      const fileName = 'test-upload-file.txt';
      const fileSize = fs.statSync(tempFilePath).size;

      // Загружаем файл через uploadFile
      const result = await difyApi.uploadFile(
        adminKey,
        testDatasetId,
        fileStream,
        fileName,
        'integration-test',
        fileSize
      );

      // Проверяем результат
      expect(result).toBeDefined();
      expect(result.document_id).toBeDefined();
      expect(result.status).toBeDefined();
      // Статус может быть 'indexing' или 'completed' в зависимости от скорости обработки
      expect(['indexing', 'completed']).toContain(result.status);
    } finally {
      // Удаляем временный файл
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }, 60000);

  test('должен загрузить файл, скачанный через FileService', async () => {
    if (!isDifyAvailable) {
      console.log('Пропуск теста: Dify API недоступен');
      return;
    }
    expect(testDatasetId).toBeTruthy();

    // Скачиваем файл через FileService
    const testUrl = 'https://www.google.com/favicon.ico';
    const downloadResult = await FileService.downloadStream(testUrl);

    expect(downloadResult.stream).toBeDefined();
    expect(downloadResult.size).toBeGreaterThan(0);

    // Загружаем файл в Dify с knownLength
    const fileName = 'downloaded-favicon.ico';
    const result = await difyApi.uploadFile(
      adminKey,
      testDatasetId,
      downloadResult.stream,
      fileName,
      'integration-test',
      downloadResult.size
    );

    // Проверяем результат
    expect(result).toBeDefined();
    expect(result.document_id).toBeDefined();
  }, 60000);
});

