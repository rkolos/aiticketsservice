const FormData = require('form-data');
const difyClient = require('./client');
const { DifyApiError } = require('../../core/errors');
const logger = require('../../utils/logger');

/**
 * Группа 1: Workflow & Chat
 */

/**
 * Запуск Workflow
 * @param {string} apiKey - API ключ приложения
 * @param {Object} inputs - Входные переменные для workflow
 * @param {string} user - ID пользователя
 * @returns {Promise<Object>} Результаты выполнения workflow (data.outputs)
 */
async function runWorkflow(apiKey, inputs, user) {
  try {
    const response = await difyClient.post(
      '/workflows/run',
      {
        inputs,
        response_mode: 'blocking',
        user,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.outputs || response.data;
  } catch (error) {
    logger.error('Error running workflow', { error: error.message });
    throw error;
  }
}

/**
 * Отправка сообщения в чат
 * @param {string} apiKey - API ключ приложения
 * @param {string} query - Текст запроса
 * @param {Object} inputs - Дополнительные входные переменные
 * @param {string} user - ID пользователя
 * @param {string} conversationId - ID беседы (опционально)
 * @returns {Promise<Object>} Полный ответ, включая metadata.usage
 */
async function sendChatMessage(apiKey, query, inputs, user, conversationId = null) {
  try {
    const body = {
      query,
      inputs: inputs || {},
      response_mode: 'blocking',
      user,
    };

    if (conversationId) {
      body.conversation_id = conversationId;
    }

    const response = await difyClient.post('/chat-messages', body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.data;
  } catch (error) {
    logger.error('Error sending chat message', { error: error.message });
    throw error;
  }
}

/**
 * Группа 2: Управление Датасетами (Knowledge Base)
 */

/**
 * Получить список датасетов
 * @param {string} apiKey - Admin API ключ
 * @param {number} page - Номер страницы
 * @param {number} limit - Количество на странице
 * @returns {Promise<Object>} Массив датасетов и метаданные пагинации
 */
async function listDatasets(apiKey, page = 1, limit = 20) {
  try {
    const response = await difyClient.get('/datasets', {
      params: {
        page,
        limit,
      },
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.data;
  } catch (error) {
    logger.error('Error listing datasets', { error: error.message });
    throw error;
  }
}

/**
 * Создать новый датасет
 * @param {string} apiKey - Admin API ключ
 * @param {string} name - Название датасета
 * @returns {Promise<Object>} Объект созданного датасета (с id)
 */
async function createDataset(apiKey, name) {
  try {
    const response = await difyClient.post(
      '/datasets',
      {
        name,
        permission: 'only_me',
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error creating dataset', { name, error: error.message });
    throw error;
  }
}

/**
 * Удалить датасет
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @returns {Promise<Object>} Результат удаления
 */
async function deleteDataset(apiKey, datasetId) {
  try {
    const response = await difyClient.delete(`/datasets/${datasetId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.data || { success: true };
  } catch (error) {
    // Если датасет не существует (404), это не критическая ошибка
    if (error instanceof DifyApiError && error.statusCode === 404) {
      logger.warn('Dataset not found during deletion (may already be deleted)', {
        datasetId,
      });
      return { success: true, alreadyDeleted: true };
    }

    logger.error('Error deleting dataset', { datasetId, error: error.message });
    throw error;
  }
}

/**
 * Группа 3: Работа с документами и Поиск (Retrieval)
 */

/**
 * Создать документ из текста
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @param {string} name - Название документа
 * @param {string} text - Текст документа
 * @returns {Promise<Object>} Результат создания
 */
async function createDocumentByText(apiKey, datasetId, name, text) {
  try {
    const response = await difyClient.post(
      `/datasets/${datasetId}/document/create_by_text`,
      {
        name,
        text,
        indexing_technique: 'high_quality',
        process_rule: {
          mode: 'automatic',
          rules: {},
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error creating document by text', {
      datasetId,
      name,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Загрузить файл в датасет
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @param {Stream} fileStream - Поток файла
 * @param {string} fileName - Имя файла
 * @param {string} user - ID пользователя (по умолчанию 'system')
 * @param {number} fileSize - Размер файла в байтах (опционально, для knownLength)
 * @returns {Promise<Object>} Результат загрузки
 */
async function uploadFile(apiKey, datasetId, fileStream, fileName, user = 'system', fileSize = null) {
  try {
    const formData = new FormData();

    // Добавляем файл с опциями
    const fileOptions = {
      filename: fileName,
    };

    // Если известен размер файла, указываем knownLength для предотвращения chunked encoding
    if (fileSize !== null && fileSize !== undefined) {
      fileOptions.knownLength = fileSize;
    }

    formData.append('file', fileStream, fileOptions);

    // Добавляем данные о правилах индексации
    const dataField = JSON.stringify({
      indexing_technique: 'high_quality',
      process_rule: {
        mode: 'automatic',
        rules: {},
      },
    });

    formData.append('data', dataField);

    const response = await difyClient.post(`/datasets/${datasetId}/document/create_by_file`, formData, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...formData.getHeaders(),
      },
    });

    return response.data;
  } catch (error) {
    logger.error('Error uploading file', {
      datasetId,
      fileName,
      fileSize,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Получить список документов в датасете
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @param {number} page - Номер страницы
 * @param {number} limit - Количество на странице
 * @returns {Promise<Object>} Массив документов и метаданные пагинации
 */
async function listDocuments(apiKey, datasetId, page = 1, limit = 20) {
  try {
    const response = await difyClient.get(`/datasets/${datasetId}/documents`, {
      params: {
        page,
        limit,
      },
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.data;
  } catch (error) {
    logger.error('Error listing documents', {
      datasetId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Удалить документ из датасета
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @param {string} documentId - ID документа
 * @returns {Promise<Object>} Результат удаления
 */
async function deleteDocument(apiKey, datasetId, documentId) {
  try {
    const response = await difyClient.delete(`/datasets/${datasetId}/documents/${documentId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.data || { success: true };
  } catch (error) {
    logger.error('Error deleting document', {
      datasetId,
      documentId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Поиск релевантных сегментов в базе знаний (External RAG)
 * @param {string} apiKey - Admin API ключ
 * @param {string} datasetId - ID датасета
 * @param {string} query - Текст запроса
 * @param {number} limit - Максимальное количество результатов (по умолчанию 5)
 * @returns {Promise<Array>} Массив найденных сегментов (records/chunks) с контентом и скором
 */
async function retrieveChunks(apiKey, datasetId, query, limit = 5) {
  try {
    const response = await difyClient.post(
      `/datasets/${datasetId}/retrieve`,
      {
        query,
        retrieval_model: {
          search_method: 'hybrid',
          rerun_model: null,
          top_k: limit,
          score_threshold_enabled: false,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    // Возвращаем массив записей (chunks) с контентом и скором
    return response.data.records || response.data || [];
  } catch (error) {
    logger.error('Error retrieving chunks', {
      datasetId,
      query: query.substring(0, 50),
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  // Workflow & Chat
  runWorkflow,
  sendChatMessage,
  // Datasets Management
  listDatasets,
  createDataset,
  deleteDataset,
  // Documents & Retrieval
  createDocumentByText,
  uploadFile,
  listDocuments,
  deleteDocument,
  retrieveChunks,
};

