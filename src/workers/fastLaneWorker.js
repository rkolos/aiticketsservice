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
const { trimLogObject } = require('../utils/logTrimmer');

/**
 * Собирает контекст из чанков в структурированную строку Markdown
 * Используется в: src/workers/fastLaneWorker.js (pruneContext) - для форматирования контекста перед передачей в LLM
 */
function assembleContext(adminChunks, historyChunks) {
  const parts = [];

  if (adminChunks.length === 0 && historyChunks.length === 0) {
    return 'Контекст не найден';
  }

  parts.push('## Контекст из базы знаний');
  parts.push('');

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

  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  return parts.join('\n');
}

/**
 * Вычисляет минимальный лимит токенов из трех уровней ограничений (Dify input variable, Dify request body, model context window)
 * Используется в: src/workers/fastLaneWorker.js (handleGenResponse) - для определения лимитов перед обрезкой контекста и истории
 */
function calculateLimits(contextTokens, historyTokens, queryTokens) {
  const modelContextWindow = config.model.contextWindow;
  const maxInputVariableSize = config.dify.workflow.maxInputVariableSize;
  const maxRequestBodySize = config.dify.workflow.maxRequestBodySize;

  const BYTES_PER_TOKEN = 4;

  const difyInputVariableLimitTokens = Math.floor(maxInputVariableSize / BYTES_PER_TOKEN);

  const systemPromptTokens = 100;
  const difyRequestBodyLimitTokens = Math.floor(maxRequestBodySize / BYTES_PER_TOKEN) - queryTokens - systemPromptTokens;

  const modelLimitTokens = Math.floor(modelContextWindow * 0.8) - queryTokens - systemPromptTokens;

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
 * Обрезает контекст с учетом приоритетов: сначала удаляет historyChunks, затем обрезает содержимое adminChunks
 * Используется в: src/workers/fastLaneWorker.js (handleGenResponse) - для обрезки контекста при превышении лимитов токенов
 */
function pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId) {
  const adminChunksWithTokens = adminChunks.map(chunk => {
    const content = chunk.content || chunk.text || '';
    const tokens = tokenCounter.countTokens(content, modelName);
    return { ...chunk, tokens };
  });

  const historyChunksWithTokens = historyChunks.map(chunk => {
    const content = chunk.content || chunk.text || '';
    const tokens = tokenCounter.countTokens(content, modelName);
    return { ...chunk, tokens };
  });

  const adminHeader = adminChunks.length > 0 ? '## Контекст из базы знаний\n\n### Административная база\n\n' : '';
  const historyHeader = historyChunks.length > 0 ? '\n\n### История тикетов\n\n' : '';
  const adminHeaderTokens = adminChunks.length > 0 ? tokenCounter.countTokens(adminHeader, modelName) : 0;
  const historyHeaderTokens = historyChunks.length > 0 ? tokenCounter.countTokens(historyHeader, modelName) : 0;
  const headersTokens = adminHeaderTokens + historyHeaderTokens;
  
  const separatorTokens = tokenCounter.countTokens('\n\n', modelName);
  const adminSeparatorsTokens = adminChunks.length > 0 ? separatorTokens * (adminChunks.length - 1) : 0;
  const historySeparatorsTokens = historyChunks.length > 0 ? separatorTokens * (historyChunks.length - 1) : 0;

  const adminTokensSum = adminChunksWithTokens.reduce((sum, chunk) => sum + chunk.tokens, 0);
  const historyTokensSum = historyChunksWithTokens.reduce((sum, chunk) => sum + chunk.tokens, 0);
  let currentTotal = headersTokens + adminTokensSum + adminSeparatorsTokens + historyTokensSum + historySeparatorsTokens;

  const pruningInfo = {
    originalAdminChunksCount: adminChunks.length,
    originalHistoryChunksCount: historyChunks.length,
    originalTokens: currentTotal,
    prunedAdminChunksCount: adminChunks.length,
    prunedHistoryChunksCount: historyChunks.length,
    prunedTokens: currentTotal,
    removedHistoryChunks: 0,
    trimmedAdminChunks: false,
  };

  if (currentTotal <= contextLimit) {
    const prunedContext = assembleContext(adminChunks, historyChunks);
    return {
      adminChunks,
      historyChunks,
      context: prunedContext,
      pruningInfo,
    };
  }

  let prunedAdminChunks = adminChunksWithTokens.map(chunk => ({ ...chunk }));
  let prunedHistoryChunks = historyChunksWithTokens.map(chunk => ({ ...chunk }));

  while (prunedHistoryChunks.length > 0 && currentTotal > contextLimit) {
    const removedChunk = prunedHistoryChunks.pop();
    currentTotal -= removedChunk.tokens;
    if (prunedHistoryChunks.length > 0) {
      currentTotal -= separatorTokens;
    } else {
      if (historyChunks.length > 0) {
        currentTotal -= historyHeaderTokens;
      }
    }
    pruningInfo.removedHistoryChunks++;
  }

  if (currentTotal > contextLimit && prunedAdminChunks.length > 0) {
    pruningInfo.trimmedAdminChunks = true;

    for (let i = prunedAdminChunks.length - 1; i >= 0 && currentTotal > contextLimit; i--) {
      const chunk = prunedAdminChunks[i];
      const content = chunk.content || chunk.text || '';

      if (chunk.tokens === 0) {
        continue;
      }

      const tokensToRemove = currentTotal - contextLimit;
      const tokensToKeep = Math.max(0, chunk.tokens - tokensToRemove);

      const charsToKeep = Math.floor((tokensToKeep / chunk.tokens) * content.length);

      const trimmedContent = content.substring(0, Math.max(0, charsToKeep));
      
      const trimmedTokens = tokenCounter.countTokens(trimmedContent, modelName);
      
      currentTotal = currentTotal - chunk.tokens + trimmedTokens;
      
      prunedAdminChunks[i] = {
        ...chunk,
        content: trimmedContent,
        text: trimmedContent,
        tokens: trimmedTokens,
      };
    }
  }

  const finalAdminChunks = prunedAdminChunks.map(({ tokens, ...chunk }) => chunk);
  const finalHistoryChunks = prunedHistoryChunks.map(({ tokens, ...chunk }) => chunk);
  const prunedContext = assembleContext(finalAdminChunks, finalHistoryChunks);

  const finalTokens = tokenCounter.countTokens(prunedContext, modelName);
  
  pruningInfo.prunedAdminChunksCount = finalAdminChunks.length;
  pruningInfo.prunedHistoryChunksCount = finalHistoryChunks.length;
  pruningInfo.prunedTokens = finalTokens;

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
    adminChunks: finalAdminChunks,
    historyChunks: finalHistoryChunks,
    context: prunedContext,
    pruningInfo,
  };
}

/**
 * Обрезает историю тикета при превышении лимита токенов, удаляя старые сообщения с конца
 * Используется в: src/workers/fastLaneWorker.js (handleGenResponse) - для обрезки истории при превышении лимитов токенов
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

  const charsToKeep = Math.floor((historyLimit / originalTokens) * history.length);

  let prunedHistory = history.substring(0, Math.max(0, charsToKeep));

  const lines = prunedHistory.split('\n');
  const rolePattern = /^(User|Assistant|user|assistant):\s+.+$/;

  while (lines.length > 0 && !rolePattern.test(lines[lines.length - 1]?.trim())) {
    lines.pop();
  }

  prunedHistory = lines.join('\n');
  const prunedTokens = tokenCounter.countTokens(prunedHistory, modelName);

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
 * Обрабатывает задачу CMD_GEN_RESPONSE: выполняет External RAG (поиск, сборка контекста, обрезка, генерация ответа)
 * Используется в: src/workers/fastLaneWorker.js (fastLaneWorker) - для обработки запросов на генерацию ответов с RAG
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

  const [simplificationResult, adminKbId, historyKbId] = await Promise.all([
    difyApi.simplifyUserQuery(query, orgId),
    OrganizationService.ensureAdminKb(orgId),
    OrganizationService.ensureHistoryKb(orgId)
  ]);

  // Извлекаем processedQuery из результата упрощения запроса
  const processedQuery = simplificationResult.query;
  const simplificationUsage = simplificationResult.usage;

  logger.info('CMD_GEN_RESPONSE: Query simplified and knowledge base IDs retrieved', {
    jobId: job.id,
    orgId,
    originalLength: query.length,
    processedLength: processedQuery.length,
    originalQuery: query.substring(0, 50),
    processedQuery: processedQuery.substring(0, 50),
    adminKbId,
    historyKbId,
    simplificationUsage: {
      promptTokens: simplificationUsage.prompt_tokens,
      completionTokens: simplificationUsage.completion_tokens,
      totalTokens: simplificationUsage.total_tokens,
    }
  });

  const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      throw new Error('Dify admin key is not configured');
    }

    const searchPromises = [
      adminKbId ? difyApi.retrieve(adminKbId, processedQuery) : Promise.resolve([]),
      historyKbId ? difyApi.retrieveChunks(adminKey, historyKbId, processedQuery, 5) : Promise.resolve([])
    ];

    const [adminResult, historyResult] = await Promise.allSettled(searchPromises);

    let context = '';
    let retrievedRecords = [];
    let historyChunks = [];

    if (adminResult.status === 'fulfilled' && adminKbId) {
      try {
        const results = adminResult.value;
        
        logger.info(`CMD_GEN_RESPONSE: Retrieve results`, {
          jobId: job.id,
          orgId,
          adminKbId,
          hasResults: !!results,
          resultsType: typeof results,
          isArray: Array.isArray(results),
          resultsKeys: results && typeof results === 'object' ? Object.keys(results) : [],
          recordsCount: results?.records?.length || (Array.isArray(results) ? results.length : 0),
          query: query.substring(0, 50),
        });
        
        let records = [];
        if (Array.isArray(results)) {
          records = results;
        } else if (results && results.records && Array.isArray(results.records)) {
          records = results.records;
        } else if (results && results.data && Array.isArray(results.data)) {
          records = results.data;
        }
        
        if (records && records.length > 0) {
          retrievedRecords = records.map(record => {
            const recordData = {
              content: record.segment?.content || record.content || '',
              score: record.score || 0,
              source: 'admin_kb',
            };
            
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
          
          if (records.length > 0) {
            logger.debug('CMD_GEN_RESPONSE: First record structure', {
              jobId: job.id,
              recordKeys: Object.keys(records[0]),
              hasDocument: !!records[0].document,
              hasSegmentDocument: !!records[0].segment?.document,
              documentKeys: records[0].document ? Object.keys(records[0].document) : [],
              recordContent: records[0].segment?.content?.substring(0, 100) || records[0].content?.substring(0, 100) || 'NO CONTENT',
            });
          }

          context = records
            .map(r => r.segment?.content || r.content || '')
            .filter(content => content.trim().length > 0)
            .join('\n\n');

          logger.info(`CMD_GEN_RESPONSE: Retrieved ${records.length} chunks via Hybrid Search and Jina Reranker`, {
            jobId: job.id,
            orgId,
            adminKbId,
            retrievedRecordsCount: retrievedRecords.length,
            retrievedRecordsPreview: retrievedRecords.slice(0, 2).map(r => ({
              contentLength: r.content?.length || 0,
              score: r.score,
              source: r.source,
              hasDocumentName: !!r.documentName,
            })),
          });
        } else {
          logger.info('CMD_GEN_RESPONSE: No relevant chunks found via Hybrid Search', {
            jobId: job.id,
            orgId,
            adminKbId,
            recordsLength: records?.length || 0,
          });
        }
      } catch (error) {
        logger.warn('CMD_GEN_RESPONSE: RAG Retrieval failed, continuing without context', {
          jobId: job.id,
          orgId,
          adminKbId,
          error: error.message,
        });
      }
    } else if (adminResult.status === 'rejected') {
      logger.warn('CMD_GEN_RESPONSE: RAG Retrieval failed, continuing without context', {
        jobId: job.id,
        orgId,
        adminKbId,
        error: adminResult.reason?.message || adminResult.reason,
      });
    } else if (!adminKbId) {
      logger.info('CMD_GEN_RESPONSE: No admin knowledge base available', {
        jobId: job.id,
        orgId,
      });
    }

    if (historyResult.status === 'fulfilled' && historyKbId) {
      try {
        historyChunks = historyResult.value;
        
        if (historyChunks && historyChunks.length > 0) {
          const historyRecords = historyChunks.map(chunk => {
            const recordData = {
              content: chunk.segment?.content || chunk.content || '',
              score: chunk.score || 0,
              source: 'history_kb',
            };
            
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
          
          retrievedRecords = [...retrievedRecords, ...historyRecords];
          
          logger.info('CMD_GEN_RESPONSE: History chunks added to retrievedRecords', {
            jobId: job.id,
            orgId,
            historyKbId,
            historyRecordsCount: historyRecords.length,
            totalRetrievedRecordsCount: retrievedRecords.length,
          });
        }
      } catch (error) {
        logger.warn('CMD_GEN_RESPONSE: Error retrieving history chunks', {
          jobId: job.id,
          orgId,
          historyKbId,
          error: error.message,
        });
      }
    } else if (historyResult.status === 'rejected') {
      logger.warn('CMD_GEN_RESPONSE: Error retrieving history chunks', {
        jobId: job.id,
        orgId,
        historyKbId,
        error: historyResult.reason?.message || historyResult.reason,
      });
    }
    
    logger.info('CMD_GEN_RESPONSE: RetrievedRecords before context pruning', {
      jobId: job.id,
      orgId,
      retrievedRecordsCount: retrievedRecords.length,
      retrievedRecordsSummary: retrievedRecords.map(r => ({
        contentLength: r.content?.length || 0,
        score: r.score,
        source: r.source,
      })),
    });

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

    const prunedHistoryResult = pruneHistory(
      formattedHistory,
      modelName,
      limits.historyLimit,
      job.id
    );

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

    const workflowInputs = {
      query,
      history: prunedHistoryResult.history,
      context: prunedContextResult.context,
      lang: lang || 'en',
    };

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

      await handleDifyResourceError(workflowError, orgId);

      await sendResult('CMD_GEN_RESPONSE', createErrorPayload(workflowError, meta), meta);

      throw workflowError;
    }

    const generationUsage = BillingService.extractUsage(workflowOutputs);

    logger.info('CMD_GEN_RESPONSE: Generation usage extracted', {
      jobId: job.id,
      orgId,
      promptTokens: generationUsage.prompt_tokens,
      completionTokens: generationUsage.completion_tokens,
      totalTokens: generationUsage.total_tokens,
      ...(generationUsage.model && { model: generationUsage.model }),
    });

    const totalUsage = BillingService.accumulateUsage([simplificationUsage, generationUsage]);

    logger.info('CMD_GEN_RESPONSE: Usage stages collected', {
      jobId: job.id,
      orgId,
      stages: totalUsage.stages.length,
    });

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

    const sources =
      workflowOutputs.sources ||
      workflowOutputs.references ||
      workflowOutputs.documents ||
      [];

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

    logger.info(`CMD_GEN_RESPONSE: Returning result`, {
      jobId: job.id,
      orgId,
      retrievedRecordsCount: retrievedRecords.length,
      retrievedRecords: trimLogObject(retrievedRecords),
      contextLength: prunedContextResult.context.length,
    });

    const usageData = {
      ...(totalUsage.model && { model: totalUsage.model }),
      stages: totalUsage.stages,
    };

    const result = formatSuccess(
      {
        content: text,
        ...(finalSources.length > 0 && { sources: finalSources }),
        retrievedContext: retrievedRecords,
      },
      meta,
      job.id,
      startTime
    );

    logger.info('CMD_GEN_RESPONSE: Final result structure', {
      jobId: job.id,
      orgId,
      hasRetrievedContext: 'retrievedContext' in result.data,
      retrievedContextType: typeof result.data?.retrievedContext,
      retrievedContextIsArray: Array.isArray(result.data?.retrievedContext),
      retrievedContextLength: result.data?.retrievedContext?.length || 0,
      retrievedRecordsLength: retrievedRecords.length,
      resultDataKeys: Object.keys(result.data || {}),
      resultData: trimLogObject(result.data),
    });

    result.meta.usage = usageData;

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
 * Обрабатывает задачу CMD_ANALYZE_NEW_TICKET: классифицирует тикет и определяет настроение
 * Используется в: src/workers/fastLaneWorker.js (fastLaneWorker) - для анализа новых тикетов
 */
async function handleAnalyzeNewTicket(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  
  const text = extractContent(job.data) || job.data?.text;
  const targetLang = extractTargetLang(job.data) || job.data?.targetLanguage || 'en';

  logger.info('CMD_ANALYZE_NEW_TICKET: Starting analysis', {
    jobId: job.id,
    textLength: text?.length,
    targetLang,
  });

  const classifierKey = config.dify.keys.classifier;
    if (!classifierKey) {
      throw new Error('Dify classifier key is not configured');
    }

    const workflowInputs = {
      message: text,
      lang: targetLang, // Имя переменной для workflow API
    };

    const workflowOutputs = await difyApi.runWorkflow(
      classifierKey,
      workflowInputs,
      meta.user || 'system'
    );

    logger.info('CMD_ANALYZE_NEW_TICKET: raw workflow output', {
      jobId: job.id,
      raw: workflowOutputs,
    });

    const workflowResponse = workflowOutputs;

    const usage = BillingService.extractUsage(workflowResponse);

    logger.info('CMD_ANALYZE_NEW_TICKET: Usage extracted', {
      jobId: job.id,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      ...(usage.model && { model: usage.model }),
    });

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

    const validSentiments = ['positive', 'neutral', 'negative'];
    if (!validSentiments.includes(parsed.sentiment.toLowerCase())) {
      logger.warn('CMD_ANALYZE_NEW_TICKET: Invalid sentiment value', {
        jobId: job.id,
        sentiment: parsed.sentiment,
      });
    }

    const usageData = {
      ...(usage.model && { model: usage.model }),
      stages: [{
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ...(usage.model && { model: usage.model }),
      }],
    };

    const result = formatSuccess(
      {
        title: parsed.title,
        sentiment: parsed.sentiment.toLowerCase(),
      },
      meta,
      job.id,
      startTime
    );

    result.meta.usage = usageData;

    await sendResult('CMD_ANALYZE_NEW_TICKET', result, meta);

    logger.info('CMD_ANALYZE_NEW_TICKET: Analysis completed', {
      jobId: job.id,
      title: parsed.title,
      sentiment: parsed.sentiment,
    });
}

/**
 * Обрабатывает задачу CMD_TRANSLATE: переводит текст на целевой язык через Dify translator workflow
 * Используется в: src/workers/fastLaneWorker.js (fastLaneWorker) - для перевода текста
 */
async function handleTranslate(job) {
  const startTime = Date.now();
  const meta = job.data?.meta || {};
  
  const text = extractContent(job.data) || job.data?.text;
  const targetLang = extractTargetLang(job.data) || job.data?.targetLang || job.data?.lang || 'en';

  logger.info('CMD_TRANSLATE: Starting translation', {
    jobId: job.id,
    textLength: text?.length,
    targetLang,
  });

  const workflowKey = config.dify.keys.translator;
  if (!workflowKey) {
    throw new Error('Dify translator key is not configured');
  }

  const inputs = {
    lang: targetLang
  };

  const result = await difyApi.sendChatMessage(workflowKey, text, inputs, meta.user || 'system');

  const translatedText = result.answer || result.data?.answer || '';

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

  const usageData = {
    ...(usage.model && { model: usage.model }),
    stages: [{
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      ...(usage.model && { model: usage.model }),
    }],
  };

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

  responseResult.meta.usage = usageData;

  await sendResult('CMD_TRANSLATE', responseResult, responseResult.meta);
}

/**
 * Обрабатывает задачу CMD_KB_LIST_FILES: получает список файлов из базы знаний организации
 * Используется в: src/workers/fastLaneWorker.js (fastLaneWorker) - для получения списка файлов в базе знаний
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

    // Для CMD_KB_LIST_FILES нужен только adminKbId, historyKbId не обязателен
    // Используем ensureAdminKb вместо getKbIdsOrThrow, так как historyKbId может еще не существовать
    let adminKbId;
    try {
      adminKbId = await OrganizationService.ensureAdminKb(orgId);
    } catch (error) {
      logger.error('CMD_KB_LIST_FILES: Failed to ensure admin KB', {
        jobId: job.id,
        orgId,
        error: error.message,
      });
      throw error;
    }

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
 * Обрабатывает задачу CMD_KB_DELETE_FILE: удаляет файл из базы знаний организации
 * Используется в: src/workers/fastLaneWorker.js (fastLaneWorker) - для удаления файлов из базы знаний
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

    const kbIds = await OrganizationService.getKbIdsOrThrow(orgId);
    const adminKbId = kbIds.adminKbId;

    await difyApi.deleteDocument(adminKey, adminKbId, fileId);

    const result = formatSuccess(
      {
        deleted: true,
        documentId: fileId,
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
 * Обрабатывает задачи Fast Lane (интерактивные): маршрутизирует задачи к соответствующим обработчикам
 * Используется в: src/infrastructure/bullmq/index.js (initWorkers) - как процессор для Fast Lane Worker
 */
async function fastLaneWorker(job) {
  logger.info('Fast Lane job processing', {
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });

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

module.exports = createSafeProcessor('FastLane', fastLaneWorker);
module.exports.assembleContext = assembleContext;
module.exports.calculateLimits = calculateLimits;
module.exports.pruneContext = pruneContext;
module.exports.pruneHistory = pruneHistory;

