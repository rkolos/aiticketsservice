const logger = require('../utils/logger');
const OrganizationService = require('../services/OrganizationService');
const difyApi = require('../infrastructure/dify/api');
const createSafeProcessor = require('../utils/safeProcessor');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const { createErrorPayload, handleDifyResourceError } = require('../utils/errorHandler');
const { KbNotFoundError } = require('../core/errors');
const config = require('../config');
const tokenCounter = require('../utils/tokenCounter');
const historyFormatter = require('../utils/historyFormatter');
const BillingService = require('../services/BillingService');
const llmParser = require('../utils/llmParser');
const { formatSuccess, wrapArray } = require('../utils/responseFormatter');
const { extractContent, extractTargetLang } = require('../utils/requestNormalizer');

/**
 * Сборка контекста из чанков в структурированную строку Markdown
 * @param {Array} adminChunks - Чанки из административной базы знаний
 * @param {Array} historyChunks - Чанки из базы истории тикетов
 * @returns {string} Структурированная строка Markdown с контекстом
 */
function assembleContext(adminChunks, historyChunks) {
  const parts = [];

  // Проверяем, есть ли хотя бы один чанк
  if (adminChunks.length === 0 && historyChunks.length === 0) {
    return 'Контекст не найден';
  }

  parts.push('## Контекст из базы знаний');
  parts.push('');

  // Административная база
  if (adminChunks.length > 0) {
    parts.push('### Административная база');
    parts.push('');

    for (const chunk of adminChunks) {
      const content = chunk.content || chunk.text || '';
      if (content.trim()) {
        parts.push(content.trim());
        parts.push('');
      }
    }
  }

  // История тикетов
  if (historyChunks.length > 0) {
    parts.push('### История тикетов');
    parts.push('');

    for (const chunk of historyChunks) {
      const content = chunk.content || chunk.text || '';
      if (content.trim()) {
        parts.push(content.trim());
        parts.push('');
      }
    }
  }

  // Убираем последнюю пустую строку
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  return parts.join('\n');
}

/**
 * Вычисление минимального лимита из трех уровней для переменной
 * @param {number} contextTokens - Токены контекста
 * @param {number} historyTokens - Токены истории
 * @param {number} queryTokens - Токены запроса
 * @returns {Object} Объект с лимитами для context и history
 */
function calculateLimits(contextTokens, historyTokens, queryTokens) {
  const modelContextWindow = config.model.contextWindow;
  const maxInputVariableSize = config.dify.workflow.maxInputVariableSize; // В байтах
  const maxRequestBodySize = config.dify.workflow.maxRequestBodySize; // В байтах

  // Приблизительный перевод токенов в байты (консервативная оценка: 1 токен ≈ 4 байта)
  const BYTES_PER_TOKEN = 4;

  // Лимит Dify на размер входной переменной (в токенах)
  const difyInputVariableLimitTokens = Math.floor(maxInputVariableSize / BYTES_PER_TOKEN);

  // Лимит Dify на размер POST-запроса (в токенах)
  // Учитываем все переменные: context, history, query + системный промпт (~100 токенов)
  const systemPromptTokens = 100;
  const difyRequestBodyLimitTokens = Math.floor(maxRequestBodySize / BYTES_PER_TOKEN) - queryTokens - systemPromptTokens;

  // Лимит контекстного окна модели (оставляем 20% для ответа)
  const modelLimitTokens = Math.floor(modelContextWindow * 0.8) - queryTokens - systemPromptTokens;

  // Выбираем минимальный лимит для каждой переменной отдельно
  const contextLimit = Math.min(
    difyInputVariableLimitTokens,
    difyRequestBodyLimitTokens,
    modelLimitTokens
  );

  const historyLimit = Math.min(
    difyInputVariableLimitTokens,
    difyRequestBodyLimitTokens,
    modelLimitTokens
  );

  return {
    contextLimit,
    historyLimit,
    limits: {
      difyInputVariable: difyInputVariableLimitTokens,
      difyRequestBody: difyRequestBodyLimitTokens,
      modelContextWindow: modelLimitTokens,
    },
  };
}

/**
 * Обрезка контекста с учетом приоритетов
 * @param {Array} adminChunks - Чанки из административной базы знаний
 * @param {Array} historyChunks - Чанки из базы истории тикетов
 * @param {string} modelName - Имя модели
 * @param {number} contextLimit - Лимит токенов для контекста
 * @param {string} jobId - ID задачи для логирования
 * @returns {Object} Объект с обрезанными чанками и информацией об обрезке
 */
function pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId) {
  let prunedAdminChunks = [...adminChunks];
  let prunedHistoryChunks = [...historyChunks];
  let prunedContext = assembleContext(prunedAdminChunks, prunedHistoryChunks);
  let currentTokens = tokenCounter.countTokens(prunedContext, modelName);

  const pruningInfo = {
    originalAdminChunksCount: adminChunks.length,
    originalHistoryChunksCount: historyChunks.length,
    originalTokens: currentTokens,
    prunedAdminChunksCount: prunedAdminChunks.length,
    prunedHistoryChunksCount: prunedHistoryChunks.length,
    prunedTokens: currentTokens,
    removedHistoryChunks: 0,
    trimmedAdminChunks: false,
  };

  // Если контекст не превышает лимит, возвращаем как есть
  if (currentTokens <= contextLimit) {
    return {
      adminChunks: prunedAdminChunks,
      historyChunks: prunedHistoryChunks,
      context: prunedContext,
      pruningInfo,
    };
  }

  // Шаг 1: Обрезаем historyChunks с конца массива
  while (prunedHistoryChunks.length > 0 && currentTokens > contextLimit) {
    prunedHistoryChunks.pop();
    pruningInfo.removedHistoryChunks++;
    prunedContext = assembleContext(prunedAdminChunks, prunedHistoryChunks);
    currentTokens = tokenCounter.countTokens(prunedContext, modelName);
  }

  // Шаг 2: Если после удаления всех historyChunks лимит все еще превышен,
  // обрезаем содержимое отдельных чанков из adminChunks (с конца текста)
  if (currentTokens > contextLimit && prunedAdminChunks.length > 0) {
    pruningInfo.trimmedAdminChunks = true;

    // Обрезаем каждый чанк с конца, пока не уложимся в лимит
    for (let i = prunedAdminChunks.length - 1; i >= 0 && currentTokens > contextLimit; i--) {
      const chunk = prunedAdminChunks[i];
      const content = chunk.content || chunk.text || '';
      const chunkTokens = tokenCounter.countTokens(content, modelName);

      if (chunkTokens === 0) {
        continue;
      }

      // Вычисляем, сколько токенов нужно обрезать
      const tokensToRemove = currentTokens - contextLimit;
      const tokensToKeep = Math.max(0, chunkTokens - tokensToRemove);

      // Приблизительно вычисляем, сколько символов оставить
      // Консервативная оценка: 1 токен ≈ 4 символа
      const charsToKeep = Math.floor((tokensToKeep / chunkTokens) * content.length);

      // Обрезаем чанк
      const trimmedContent = content.substring(0, Math.max(0, charsToKeep));
      prunedAdminChunks[i] = {
        ...chunk,
        content: trimmedContent,
        text: trimmedContent,
      };

      prunedContext = assembleContext(prunedAdminChunks, prunedHistoryChunks);
      currentTokens = tokenCounter.countTokens(prunedContext, modelName);
    }
  }

  pruningInfo.prunedAdminChunksCount = prunedAdminChunks.length;
  pruningInfo.prunedHistoryChunksCount = prunedHistoryChunks.length;
  pruningInfo.prunedTokens = currentTokens;

  // Логирование обрезки
  if (pruningInfo.removedHistoryChunks > 0 || pruningInfo.trimmedAdminChunks) {
    logger.warn('CMD_GEN_RESPONSE: Context pruned', {
      jobId,
      reason: 'Context limit exceeded',
      originalTokens: pruningInfo.originalTokens,
      prunedTokens: pruningInfo.prunedTokens,
      removedHistoryChunks: pruningInfo.removedHistoryChunks,
      trimmedAdminChunks: pruningInfo.trimmedAdminChunks,
      contextLimit,
    });
  }

  return {
    adminChunks: prunedAdminChunks,
    historyChunks: prunedHistoryChunks,
    context: prunedContext,
    pruningInfo,
  };
}

/**
 * Обрезка истории при превышении лимита
 * @param {string} history - История в формате Markdown
 * @param {string} modelName - Имя модели
 * @param {number} historyLimit - Лимит токенов для истории
 * @param {string} jobId - ID задачи для логирования
 * @returns {Object} Объект с обрезанной историей и информацией об обрезке
 */
function pruneHistory(history, modelName, historyLimit, jobId) {
  const originalTokens = tokenCounter.countTokens(history, modelName);

  if (originalTokens <= historyLimit) {
    return {
      history,
      pruningInfo: {
        originalTokens,
        prunedTokens: originalTokens,
        trimmed: false,
      },
    };
  }

  // Обрезаем историю с конца (удаляем старые сообщения)
  // Приблизительно вычисляем, сколько символов оставить
  const charsToKeep = Math.floor((historyLimit / originalTokens) * history.length);

  // Обрезаем строку с конца
  let prunedHistory = history.substring(0, Math.max(0, charsToKeep));

  // Пытаемся обрезать по границам сообщений (по строкам "Role: content")
  const lines = prunedHistory.split('\n');
  const rolePattern = /^(User|Assistant|user|assistant):\s+.+$/;

  // Удаляем последние строки, которые не являются началом сообщения
  while (lines.length > 0 && !rolePattern.test(lines[lines.length - 1]?.trim())) {
    lines.pop();
  }

  prunedHistory = lines.join('\n');
  const prunedTokens = tokenCounter.countTokens(prunedHistory, modelName);

  // Логирование обрезки
  logger.warn('CMD_GEN_RESPONSE: History pruned', {
    jobId,
    reason: 'History limit exceeded',
    originalTokens,
    prunedTokens,
    historyLimit,
  });

  return {
    history: prunedHistory,
    pruningInfo: {
      originalTokens,
      prunedTokens,
      trimmed: true,
    },
  };
}

/**
 * Обработчик задачи CMD_GEN_RESPONSE
 * Полный цикл External RAG: поиск -> сборка контекста -> обрезка -> генерация -> извлечение usage -> возврат результата
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleGenResponse(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  const { orgId, query, history, lang } = job.data;

  logger.info('CMD_GEN_RESPONSE: Starting retrieval', {
    jobId: job.id,
    orgId,
    query: query?.substring(0, 50),
  });

  // Шаг 0: Query Simplification - упрощение запроса для улучшения RAG поиска
  const simplificationResult = await difyApi.simplifyUserQuery(query, orgId);
  const processedQuery = simplificationResult.query;
  const simplificationUsage = simplificationResult.usage;

  logger.info('CMD_GEN_RESPONSE: Query simplified', {
    jobId: job.id,
    orgId,
    originalLength: query.length,
    processedLength: processedQuery.length,
    originalQuery: query.substring(0, 50),
    processedQuery: processedQuery.substring(0, 50),
    simplificationUsage: {
      promptTokens: simplificationUsage.prompt_tokens,
      completionTokens: simplificationUsage.completion_tokens,
      totalTokens: simplificationUsage.total_tokens,
    },
  });

    // Шаг 1: Identify Datasets - получение ID баз знаний
    // Используем ensureAdminKb и ensureHistoryKb вместо getKbIdsOrThrow,
    // чтобы гарантировать наличие баз знаний (lazy loading)
    let adminKbId, historyKbId;
    // Используем ensureAdminKb для гарантии наличия admin базы
    adminKbId = await OrganizationService.ensureAdminKb(orgId);
    // Используем ensureHistoryKb для гарантии наличия history базы
    historyKbId = await OrganizationService.ensureHistoryKb(orgId);

    logger.info('CMD_GEN_RESPONSE: Knowledge base IDs retrieved', {
      jobId: job.id,
      orgId,
      adminKbId,
      historyKbId,
    });

    // Шаг 2: Retrieval - поиск контекста из базы знаний с Hybrid Search и Reranking
    let context = '';
    let retrievedRecords = []; // Хранилище сырых данных контекста

    // Поиск в административной базе знаний с Jina Reranker
    if (adminKbId) {
      try {
        const results = await difyApi.retrieve(adminKbId, processedQuery);
        logger.info(`CMD_GEN_RESPONSE: Retrieve results`, {
          jobId: job.id,
          orgId,
          adminKbId,
          hasResults: !!results,
          recordsCount: results?.records?.length || 0,
          query: query.substring(0, 50),
        });
        if (results && results.records && results.records.length > 0) {
          // Формируем retrievedRecords с информацией об источнике и документе
          retrievedRecords = results.records.map(record => {
            const recordData = {
              content: record.segment?.content || record.content || '',
              score: record.score || 0,
              source: 'admin_kb',
            };
            
            // Добавляем имя документа, если доступно
            // Проверяем разные возможные пути к имени документа в ответе Dify API
            const documentName = 
              record.document?.name || 
              record.document?.file_name || 
              record.segment?.document?.name ||
              record.segment?.document?.file_name ||
              null;
            if (documentName) {
              recordData.documentName = documentName;
            }
            
            return recordData;
          }).filter(item => item.content.trim().length > 0);
          
          // Логируем структуру первого record для отладки
          if (results.records.length > 0) {
            logger.debug('CMD_GEN_RESPONSE: First record structure', {
              jobId: job.id,
              recordKeys: Object.keys(results.records[0]),
              hasDocument: !!results.records[0].document,
              hasSegmentDocument: !!results.records[0].segment?.document,
              documentKeys: results.records[0].document ? Object.keys(results.records[0].document) : [],
            });
          }

          // Склеиваем сегменты в строку контекста
          context = results.records
            .map(r => r.segment?.content || r.content || '')
            .filter(content => content.trim().length > 0)
            .join('\n\n');

          logger.info(`CMD_GEN_RESPONSE: Retrieved ${results.records.length} chunks via Hybrid Search and Jina Reranker`, {
            jobId: job.id,
            orgId,
            adminKbId,
          });
        } else {
          logger.info('CMD_GEN_RESPONSE: No relevant chunks found via Hybrid Search', {
            jobId: job.id,
            orgId,
            adminKbId,
          });
        }
      } catch (error) {
        logger.warn('CMD_GEN_RESPONSE: RAG Retrieval failed, continuing without context', {
          jobId: job.id,
          orgId,
          adminKbId,
          error: error.message,
        });
        // Продолжаем с пустым контекстом (graceful degradation)
      }
    } else {
      logger.info('CMD_GEN_RESPONSE: No admin knowledge base available', {
        jobId: job.id,
        orgId,
      });
    }

    // Получение чанков из истории тикетов (простой поиск для обратной совместимости)
    let historyChunks = [];
    if (historyKbId) {
      try {
        const adminKey = config.dify.keys.admin;
        if (!adminKey) {
          throw new Error('Dify admin key is not configured');
        }
        historyChunks = await difyApi.retrieveChunks(adminKey, historyKbId, processedQuery, 5);
        
        // Преобразуем historyChunks в формат retrievedRecords и объединяем с результатами из adminKb
        if (historyChunks && historyChunks.length > 0) {
          const historyRecords = historyChunks.map(chunk => {
            const recordData = {
              content: chunk.segment?.content || chunk.content || '',
              score: chunk.score || 0,
              source: 'history_kb',
            };
            
            // Добавляем имя документа, если доступно
            // Проверяем разные возможные пути к имени документа в ответе Dify API
            const documentName = 
              chunk.document?.name || 
              chunk.document?.file_name || 
              chunk.segment?.document?.name ||
              chunk.segment?.document?.file_name ||
              null;
            if (documentName) {
              recordData.documentName = documentName;
            }
            
            return recordData;
          }).filter(item => item.content.trim().length > 0);
          
          // Объединяем результаты из adminKb и historyKb
          retrievedRecords = [...retrievedRecords, ...historyRecords];
        }
      } catch (error) {
        logger.warn('CMD_GEN_RESPONSE: Error retrieving history chunks', {
          jobId: job.id,
          orgId,
          historyKbId,
          error: error.message,
        });
        // Graceful degradation: продолжаем с пустым массивом
      }
    }

    // Шаг 3: Context Assembly - сборка контекста из Hybrid Search результатов и истории
    // context уже содержит результаты Hybrid Search с Jina Reranker
    // Добавляем результаты из истории тикетов для полноты контекста
    let rawContext = context;
    if (historyChunks && historyChunks.length > 0) {
      const historyContext = historyChunks
        .map(chunk => chunk.content || chunk.segment?.content || '')
        .filter(content => content.trim().length > 0)
        .join('\n\n');

      if (historyContext.trim()) {
        rawContext = rawContext.trim()
          ? `${rawContext}\n\n## История тикетов\n\n${historyContext}`
          : `## История тикетов\n\n${historyContext}`;
      }
    }

    if (!rawContext.trim()) {
      rawContext = 'Контекст не найден';
    }

    const formattedHistory = historyFormatter.formatTicketHistory(history);

    // Шаг 4: Подсчет токенов и проверка лимитов
    const modelName = config.model.name;
    const tokenCounts = tokenCounter.estimateTotalTokens(
      rawContext,
      formattedHistory,
      query,
      modelName
    );

    logger.info('CMD_GEN_RESPONSE: Token counts', {
      jobId: job.id,
      orgId,
      contextTokens: tokenCounts.context,
      historyTokens: tokenCounts.history,
      queryTokens: tokenCounts.query,
      totalTokens: tokenCounts.total,
    });

    // Шаг 5: Context Pruning - обрезка контекста и истории при превышении лимитов
    const limits = calculateLimits(
      tokenCounts.context,
      tokenCounts.history,
      tokenCounts.query
    );

    // Обрезка контекста (теперь это простая строка из Hybrid Search)
    const originalContextTokens = tokenCounter.countTokens(rawContext, modelName);
    let prunedContext = rawContext;
    let contextTokens = originalContextTokens;
    let contextWasPruned = false;

    if (contextTokens > limits.contextLimit) {
      // Обрезаем контекст до лимита токенов
      const charsPerToken = 4; // Примерная оценка
      const maxChars = limits.contextLimit * charsPerToken;
      prunedContext = rawContext.substring(0, maxChars);
      contextTokens = tokenCounter.countTokens(prunedContext, modelName);
      contextWasPruned = true;

      logger.warn('CMD_GEN_RESPONSE: Context pruned due to token limit', {
        jobId: job.id,
        orgId,
        originalTokens: originalContextTokens,
        prunedTokens: contextTokens,
        contextLimit: limits.contextLimit,
      });
    }

    // Создаем prunedContextResult для совместимости с остальным кодом
    const prunedContextResult = {
      context: prunedContext,
      adminChunks: [], // Пустой массив для совместимости
      historyChunks: historyChunks || [],
      pruningInfo: {
        originalTokens: originalContextTokens,
        prunedTokens: contextTokens,
        removedHistoryChunks: 0,
        trimmedAdminChunks: contextWasPruned,
        originalAdminChunksCount: 0,
        originalHistoryChunksCount: historyChunks?.length || 0,
        prunedAdminChunksCount: 0,
        prunedHistoryChunksCount: historyChunks?.length || 0,
      }
    };

    // Обрезка истории
    const prunedHistoryResult = pruneHistory(
      formattedHistory,
      modelName,
      limits.historyLimit,
      job.id
    );

    // Логирование результатов обрезки
    if (
      prunedContextResult.pruningInfo.removedHistoryChunks > 0 ||
      prunedContextResult.pruningInfo.trimmedAdminChunks ||
      prunedHistoryResult.pruningInfo.trimmed
    ) {
      logger.info('CMD_GEN_RESPONSE: Pruning completed', {
        jobId: job.id,
        orgId,
        contextPruning: {
          originalTokens: prunedContextResult.pruningInfo.originalTokens,
          prunedTokens: prunedContextResult.pruningInfo.prunedTokens,
          removedHistoryChunks: prunedContextResult.pruningInfo.removedHistoryChunks,
          trimmedAdminChunks: prunedContextResult.pruningInfo.trimmedAdminChunks,
        },
        historyPruning: {
          originalTokens: prunedHistoryResult.pruningInfo.originalTokens,
          prunedTokens: prunedHistoryResult.pruningInfo.prunedTokens,
          trimmed: prunedHistoryResult.pruningInfo.trimmed,
        },
        limits: limits.limits,
      });
    }

    // Шаг 5: Generation - вызов Dify Workflow для генерации ответа
    const workflowKey = config.dify.keys.responseWorkflow;
    if (!workflowKey) {
      throw new Error('Dify response workflow key is not configured');
    }

    logger.info('CMD_GEN_RESPONSE: Starting generation', {
      jobId: job.id,
      orgId,
      contextLength: prunedContextResult.context.length,
      historyLength: prunedHistoryResult.history.length,
    });

    // Вызов Workflow с отформатированными переменными
    const workflowInputs = {
      query,
      history: prunedHistoryResult.history,
      context: prunedContextResult.context,
      lang, // Исправлено: имя переменной в workflow 'lang', а не 'language'
    };

    // Получаем ответ от Dify Workflow
    let workflowOutputs;

    try {
      workflowOutputs = await difyApi.runWorkflow(workflowKey, workflowInputs, meta.user || 'system');
    } catch (workflowError) {
      logger.error('CMD_GEN_RESPONSE: Workflow execution error', {
        jobId: job.id,
        orgId,
        error: workflowError.message,
        stack: workflowError.stack,
      });

      // Обработка ошибок с инвалидацией кэша при необходимости
      await handleDifyResourceError(workflowError, orgId);

      // Отправка ошибки в resultQueue
      await sendResult('CMD_GEN_RESPONSE', createErrorPayload(workflowError, meta), meta);

      // Выбрасываем ошибку для BullMQ retry стратегии
      throw workflowError;
    }

    // Шаг 6: Extract Usage - извлечение usage через BillingService
    const generationUsage = BillingService.extractUsage(workflowOutputs);

    logger.info('CMD_GEN_RESPONSE: Generation usage extracted', {
      jobId: job.id,
      orgId,
      promptTokens: generationUsage.prompt_tokens,
      completionTokens: generationUsage.completion_tokens,
      totalTokens: generationUsage.total_tokens,
      ...(generationUsage.model && { model: generationUsage.model }),
    });

    // Шаг 7: Accumulate Usage - суммирование токенов из всех этапов
    const totalUsage = BillingService.accumulateUsage([simplificationUsage, generationUsage]);

    logger.info('CMD_GEN_RESPONSE: Usage stages collected', {
      jobId: job.id,
      orgId,
      stages: totalUsage.stages.length,
    });

    // Шаг 7: Extract text and sources - извлечение текста ответа и источников
    // Структура ответа Dify Workflow может варьироваться
    // Обычно текст находится в outputs.text или outputs.output
    const outputs =
      workflowOutputs.outputs ||
      workflowOutputs.data?.outputs ||
      workflowOutputs;

    const text =
      outputs?.text ||
      outputs?.output ||
      outputs?.answer ||
      outputs?.response ||
      workflowOutputs.text ||
      workflowOutputs.output ||
      workflowOutputs.answer ||
      workflowOutputs.response ||
      '';

    // Источники могут быть в outputs.sources или outputs.references
    const sources =
      workflowOutputs.sources ||
      workflowOutputs.references ||
      workflowOutputs.documents ||
      [];

    // Если источники не найдены, используем информацию из чанков
    const fallbackSources = [
      ...prunedContextResult.adminChunks.map((chunk) => ({
        dataset_id: adminKbId,
        dataset_name: 'Admin KB',
        document_id: chunk.document_id || null,
        document_name: chunk.document_name || chunk.source || null,
        score: chunk.score || null,
      })),
      ...prunedContextResult.historyChunks.map((chunk) => ({
        dataset_id: historyKbId,
        dataset_name: 'History KB',
        document_id: chunk.document_id || null,
        document_name: chunk.document_name || chunk.source || null,
        score: chunk.score || null,
      })),
    ];

    const finalSources = sources.length > 0 ? sources : fallbackSources;

    // Шаг 8: Return Result - отправка финального результата в resultQueue
    logger.info(`CMD_GEN_RESPONSE: Returning result`, {
      jobId: job.id,
      orgId,
      retrievedRecordsCount: retrievedRecords.length,
      retrievedRecords: retrievedRecords,
      contextLength: prunedContextResult.context.length,
    });

    // Формирование usage для meta
    const usageData = {
      ...(totalUsage.model && { model: totalUsage.model }), // Включаем только если модель известна
      stages: totalUsage.stages,
    };

    // Форматирование ответа в стандартизированном формате
    // Переименовываем text → content
    const result = formatSuccess(
      {
        content: text,
        ...(finalSources.length > 0 && { sources: finalSources }),
        retrievedContext: retrievedRecords, // Возвращаем сырые данные контекста
      },
      meta,
      job.id,
      startTime
    );

    // Добавляем usage в meta
    result.meta.usage = usageData;

    // Передаем result.meta вместо исходного meta, чтобы сохранить usage
    await sendResult('CMD_GEN_RESPONSE', result, result.meta);

    logger.info('CMD_GEN_RESPONSE: Final result sent to result queue', {
      jobId: job.id,
      orgId,
      textLength: text.length,
      sourcesCount: finalSources.length,
      stagesCount: totalUsage.stages.length,
    });
}

/**
 * Обработчик задачи CMD_ANALYZE_NEW_TICKET
 * Анализ нового тикета: классификация и определение настроения
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleAnalyzeNewTicket(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  
  // Нормализация входных данных с поддержкой обратной совместимости
  const text = extractContent(job.data) || job.data?.text;
  const targetLang = extractTargetLang(job.data) || job.data?.targetLanguage || 'ru';

  logger.info('CMD_ANALYZE_NEW_TICKET: Starting analysis', {
    jobId: job.id,
    textLength: text?.length,
    targetLang,
  });

  const classifierKey = config.dify.keys.classifier;
    if (!classifierKey) {
      throw new Error('Dify classifier key is not configured');
    }

    // Вызов Workflow Classifier
    const workflowInputs = {
      message: text,
      lang: targetLang, // Имя переменной для workflow API
    };

    const workflowOutputs = await difyApi.runWorkflow(
      classifierKey,
      workflowInputs,
      meta.user || 'system'
    );

    // Логируем сырой ответ от workflow для диагностики формата
    logger.info('CMD_ANALYZE_NEW_TICKET: raw workflow output', {
      jobId: job.id,
      raw: workflowOutputs,
    });

    // Извлечение usage через BillingService
    const workflowResponse = workflowOutputs;

    const usage = BillingService.extractUsage(workflowResponse);

    logger.info('CMD_ANALYZE_NEW_TICKET: Usage extracted', {
      jobId: job.id,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      ...(usage.model && { model: usage.model }),
    });

    // Парсинг JSON ответа: учитываем разные расположения outputs
    const outputs =
      workflowOutputs.outputs ||
      workflowOutputs.data?.outputs ||
      workflowOutputs;

    let jsonText =
      outputs?.text ||
      outputs?.output ||
      outputs?.answer ||
      outputs?.response ||
      workflowOutputs.text ||
      workflowOutputs.output ||
      workflowOutputs.answer ||
      workflowOutputs.response ||
      '';

    if (!jsonText || jsonText.trim().length === 0) {
      throw new Error('Classifier returned empty text');
    }

    // Очистка от Markdown оберток
    const cleanedJson = llmParser.cleanLlmJson(jsonText);
    const parsed = JSON.parse(cleanedJson);

    // Валидация полей
    if (!parsed.title || typeof parsed.title !== 'string') {
      throw new Error('Invalid response: missing or invalid title field');
    }

    if (!parsed.sentiment || typeof parsed.sentiment !== 'string') {
      throw new Error('Invalid response: missing or invalid sentiment field');
    }

    // Валидация значения sentiment
    const validSentiments = ['positive', 'neutral', 'negative'];
    if (!validSentiments.includes(parsed.sentiment.toLowerCase())) {
      logger.warn('CMD_ANALYZE_NEW_TICKET: Invalid sentiment value', {
        jobId: job.id,
        sentiment: parsed.sentiment,
      });
    }

    // Формирование usage для meta
    const usageData = {
      ...(usage.model && { model: usage.model }),
      stages: [{
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ...(usage.model && { model: usage.model }),
      }],
    };

    // Форматирование ответа в стандартизированном формате
    const result = formatSuccess(
      {
        title: parsed.title,
        sentiment: parsed.sentiment.toLowerCase(),
      },
      meta,
      job.id,
      startTime
    );

    // Добавляем usage в meta
    result.meta.usage = usageData;

    await sendResult('CMD_ANALYZE_NEW_TICKET', result, meta);

    logger.info('CMD_ANALYZE_NEW_TICKET: Analysis completed', {
      jobId: job.id,
      title: parsed.title,
      sentiment: parsed.sentiment,
    });
}

/**
 * Обработчик задачи CMD_TRANSLATE
 * Перевод текста на целевой язык через специализированный translator workflow
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleTranslate(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  
  // Нормализация входных данных с поддержкой обратной совместимости
  const text = extractContent(job.data) || job.data?.text;
  const targetLang = extractTargetLang(job.data) || job.data?.targetLang || job.data?.lang || 'en';

  logger.info('CMD_TRANSLATE: Starting translation', {
    jobId: job.id,
    textLength: text?.length,
    targetLang,
  });

  // Используем специализированный translator ключ
  const workflowKey = config.dify.keys.translator;
  if (!workflowKey) {
    throw new Error('Dify translator key is not configured');
  }

  // Для translator workflow используем sendChatMessage с правильными параметрами
  // Согласно YAML: query содержит текст для перевода, inputs содержит lang
  const inputs = {
    lang: targetLang
  };

  // Вызываем Dify Chat API для перевода
  const result = await difyApi.sendChatMessage(workflowKey, text, inputs, meta.user || 'system');

  // Извлекаем переведенный текст из результата
  // sendChatMessage возвращает результат в answer
  const translatedText = result.answer || result.data?.answer || '';

  // Извлечение usage через BillingService
  const usage = BillingService.extractUsage(result);

  logger.info('CMD_TRANSLATE: Translation completed', {
    jobId: job.id,
    originalLength: text?.length || 0,
    translatedLength: translatedText?.length || 0,
    targetLang: inputs.lang,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    ...(usage.model && { model: usage.model }),
  });

  // Формирование usage для meta
  const usageData = {
    ...(usage.model && { model: usage.model }),
    stages: [{
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      ...(usage.model && { model: usage.model }),
    }],
  };

  // Форматирование ответа в стандартизированном формате
  // Унифицируем поля: original → sourceContent, translated → content
  const responseResult = formatSuccess(
    {
      content: translatedText,
      sourceContent: text,
      targetLang: inputs.lang,
    },
    meta,
    job.id,
    startTime
  );

  // Добавляем usage в meta
  responseResult.meta.usage = usageData;

  // Передаем responseResult.meta вместо исходного meta, чтобы сохранить usage
  await sendResult('CMD_TRANSLATE', responseResult, responseResult.meta);
}

/**
 * Обработчик задачи CMD_KB_LIST_FILES
 * Получение списка файлов из базы знаний организации
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleKbListFiles(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  const { orgId } = job.data;

  logger.info('CMD_KB_LIST_FILES: Starting', {
    jobId: job.id,
    orgId,
  });

  const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    let adminKbId;
    try {
      const kbIds = await OrganizationService.getKbIdsOrThrow(orgId);
      adminKbId = kbIds.adminKbId;
    } catch (error) {
      // Если база не найдена, возвращаем пустой массив (это нормально, база еще не создана)
      if (error instanceof KbNotFoundError) {
        logger.info('CMD_KB_LIST_FILES: Knowledge base not found, returning empty list', {
          jobId: job.id,
          orgId,
        });

        // Используем wrapArray для обертки пустого массива
        const result = formatSuccess(
          wrapArray([]),
          meta,
          job.id,
          startTime
        );

        await sendResult('CMD_KB_LIST_FILES', result, meta);
        return;
      }
      throw error;
    }

    // Получение списка документов
    const documentsResponse = await difyApi.listDocuments(adminKey, adminKbId, 1, 100);

    const files = (documentsResponse.data || []).map((doc) => ({
      id: doc.id,
      name: doc.name,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      word_count: doc.word_count || 0,
      status: doc.indexing_status || 'unknown',
    }));

    // Используем wrapArray для обертки массива в { items: [...], count: N }
    const result = formatSuccess(
      wrapArray(files),
      meta,
      job.id,
      startTime
    );

    await sendResult('CMD_KB_LIST_FILES', result, meta);

    logger.info('CMD_KB_LIST_FILES: Completed', {
      jobId: job.id,
      orgId,
      filesCount: files.length,
    });
}

/**
 * Обработчик задачи CMD_KB_DELETE_FILE
 * Удаление файла из базы знаний организации
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<void>}
 */
async function handleKbDeleteFile(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  const { orgId, fileId } = job.data;

  logger.info('CMD_KB_DELETE_FILE: Starting', {
    jobId: job.id,
    orgId,
    fileId,
  });

  const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    // Получение adminKbId
    const kbIds = await OrganizationService.getKbIdsOrThrow(orgId);
    const adminKbId = kbIds.adminKbId;

    // Удаление документа
    await difyApi.deleteDocument(adminKey, adminKbId, fileId);

    // Форматирование ответа в стандартизированном формате
    // Переименовываем fileId → documentId
    const result = formatSuccess(
      {
        deleted: true,
        documentId: fileId, // Унифицированное название
      },
      meta,
      job.id,
      startTime
    );

    await sendResult('CMD_KB_DELETE_FILE', result, meta);

    logger.info('CMD_KB_DELETE_FILE: File deleted', {
      jobId: job.id,
      orgId,
      fileId,
    });
}

/**
 * Fast Lane Worker - маршрутизация задач
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<any>} Результат выполнения задачи
 */
async function fastLaneWorker(job) {
  logger.info('Fast Lane job processing', {
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });

  // Маршрутизация задач через switch
  switch (job.name) {
    case 'CMD_GEN_RESPONSE':
      return await handleGenResponse(job);

    case 'CMD_ANALYZE_NEW_TICKET':
      return await handleAnalyzeNewTicket(job);

    case 'CMD_TRANSLATE':
      return await handleTranslate(job);

    case 'CMD_KB_LIST_FILES':
      return await handleKbListFiles(job);

    case 'CMD_KB_DELETE_FILE':
      return await handleKbDeleteFile(job);

    default:
      logger.warn('Unknown job name', {
        jobId: job.id,
        jobName: job.name,
      });
      return { status: 'unknown_job', jobId: job.id };
  }
}

// Экспортируем функции для тестирования
module.exports = createSafeProcessor('FastLane', fastLaneWorker);
module.exports.assembleContext = assembleContext;
module.exports.calculateLimits = calculateLimits;
module.exports.pruneContext = pruneContext;
module.exports.pruneHistory = pruneHistory;

