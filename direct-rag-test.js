/* eslint-disable no-console */
/**
 * Прямой тест RAG через Dify API
 * Тестируем загрузку файла и поиск без BullMQ воркеров
 */

const axios = require('axios');
const fs = require('fs');

// Конфигурация
const DIFY_BASE_URL = 'http://localhost:5001/v1';
const ADMIN_KEY = 'dataset-zxpSgJYepLlTZLis064ShuA7'; // Из .env
const DATASET_NAME = 'test-rag-dataset';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(method, url, data = null, headers = {}) {
  try {
    const config = {
      method,
      url: `${DIFY_BASE_URL}${url}`,
      headers: {
        'Authorization': `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
        ...headers
      }
    };

    if (data) {
      config.data = data;
    }

    console.log(`${method} ${url}`);
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`❌ Error ${method} ${url}:`, error.response?.data || error.message);
    throw error;
  }
}

async function createDataset() {
  console.log('📁 Создаем датасет...');
  try {
    const result = await makeRequest('POST', '/datasets', {
      name: DATASET_NAME,
      description: 'Test dataset for RAG debugging',
      permission: 'only_me',
      indexing_technique: 'high_quality',
      retrieval_model: {
        search_method: 'hybrid_search',
        reranking_enable: true,
        reranking_model: {
          reranking_provider_name: 'jina',
          reranking_model_name: 'jina-reranker-v2-base-multilingual'
        },
        top_k: 5,
        score_threshold_enabled: false
      }
    });
    console.log('✅ Датасет создан:', result.id);
    return result.id;
  } catch (error) {
    // Если датасет уже существует, попробуем найти его
    if (error.response?.data?.code === 'dataset_name_duplicate') {
      console.log('⚠️  Датасет уже существует, ищем...');
      try {
        const datasets = await makeRequest('GET', '/datasets');
        const existing = datasets.data.find(d => d.name === DATASET_NAME);
        if (existing) {
          console.log('✅ Найден существующий датасет:', existing.id);
          return existing.id;
        }
      } catch (findError) {
        console.log('⚠️  Не удалось найти датасет:', findError.message);
      }
    }
    throw error;
  }
}

async function uploadFile(datasetId, fileUrl) {
  console.log('📤 Загружаем файл...');

  // Сначала скачиваем файл
  console.log('⬇️  Скачиваем файл...');
  const fileResponse = await axios.get(fileUrl, { responseType: 'stream' });
  const fileName = fileUrl.split('/').pop();
  const filePath = `/tmp/${fileName}`;

  const writer = fs.createWriteStream(filePath);
  fileResponse.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  console.log('✅ Файл скачан:', filePath);

  // Загружаем файл в датасет
  const FormData = require('form-data');
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), {
    filename: fileName,
    contentType: 'text/markdown'
  });

  // Параметры индексации
  const dataField = JSON.stringify({
    indexing_technique: 'high_quality',
    process_rule: {
      mode: 'automatic',
      rules: {},
    },
  });
  formData.append('data', dataField);

  try {
    const result = await makeRequest('POST', `/datasets/${datasetId}/document/create-by-file`, formData, {
      ...formData.getHeaders()
    });
    console.log('✅ Файл загружен в датасет:', result.document?.id);

    // Удаляем временный файл
    fs.unlinkSync(filePath);

    return result.document?.id;
  } catch (error) {
    fs.unlinkSync(filePath);
    throw error;
  }
}

async function waitForIndexing(datasetId, documentId) {
  console.log('⏳ Ждем индексации...');

  for (let i = 0; i < 60; i++) { // Максимум 5 минут
    try {
      const documents = await makeRequest('GET', `/datasets/${datasetId}/documents`);
      const doc = documents.data.find(d => d.id === documentId);

      if (doc) {
        console.log(`📊 Статус документа: ${doc.indexing_status} (${doc.word_count} слов)`);

        if (doc.indexing_status === 'completed') {
          console.log('✅ Индексация завершена!');
          return true;
        } else if (doc.indexing_status === 'error') {
          throw new Error('Ошибка индексации');
        }
      }

      await sleep(5000); // Ждем 5 секунд
    } catch (error) {
      console.log(`⚠️  Ошибка проверки статуса (${i + 1}/60):`, error.message);
      await sleep(5000);
    }
  }

  throw new Error('Таймаут ожидания индексации');
}

async function testRetrieval(datasetId, query) {
  console.log(`🔍 Тестируем поиск: "${query}"`);

  try {
    const result = await makeRequest('POST', `/datasets/${datasetId}/retrieve`, {
      query,
      retrieval_model: {
        search_method: 'hybrid_search',
        reranking_enable: true,
        reranking_model: {
          reranking_provider_name: 'jina',
          reranking_model_name: 'jina-reranker-v2-base-multilingual'
        },
        top_k: 5,
        score_threshold_enabled: false
      }
    });

    console.log(`📄 Найдено чанков: ${result.records?.length || 0}`);

    if (result.records && result.records.length > 0) {
      console.log('🎯 Найденные чанки:');
      result.records.forEach((record, i) => {
        const content = record.segment?.content || record.content || '';
        const score = record.score || 0;
        console.log(`${i + 1}. Score: ${score.toFixed(3)}`);
        console.log(`   Content: ${content.substring(0, 100)}...`);
        console.log('');
      });

      return result.records;
    } else {
      console.log('❌ Чанки не найдены');
      return [];
    }
  } catch (error) {
    console.error('❌ Ошибка поиска:', error.message);
    return [];
  }
}

async function deleteDataset(datasetId) {
  console.log('🗑️  Удаляем датасет...');
  try {
    await makeRequest('DELETE', `/datasets/${datasetId}`);
    console.log('✅ Датасет удален');
  } catch (error) {
    console.log('⚠️  Не удалось удалить датасет:', error.message);
  }
}

async function main() {
  console.log('🚀 ПРЯМОЙ ТЕСТ RAG ЧЕРЕЗ DIFY API\n');

  let datasetId = null;

  try {
    // 1. Создаем датасет
    datasetId = await createDataset();

    // 2. Загружаем файл
    const fileUrl = 'https://raw.githubusercontent.com/open-webui/open-webui/main/README.md';
    const documentId = await uploadFile(datasetId, fileUrl);

    // 3. Ждем индексации
    await waitForIndexing(datasetId, documentId);

    // 4. Тестируем разные запросы
    console.log('\n🧪 ТЕСТИРУЕМ РАЗЛИЧНЫЕ ЗАПРОСЫ:\n');

    const queries = [
      'What is Open WebUI?',
      'image generation',
      'ComfyUI',
      'AUTOMATIC1111',
      'README',
      'webui',
      'generation tools'
    ];

    for (const query of queries) {
      const chunks = await testRetrieval(datasetId, query);
      if (chunks.length > 0) {
        console.log(`✅ Запрос "${query}" НАШЕЛ ${chunks.length} чанков\n`);
        break; // Если нашли хоть что-то, выходим
      } else {
        console.log(`❌ Запрос "${query}" ничего не нашел\n`);
      }
    }

  } catch (error) {
    console.error('💥 КРИТИЧЕСКАЯ ОШИБКА:', error.message);
  } finally {
    // Очистка
    if (datasetId) {
      await deleteDataset(datasetId);
    }

    console.log('\n✅ ТЕСТ ЗАВЕРШЕН');
  }
}

// Запуск
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
