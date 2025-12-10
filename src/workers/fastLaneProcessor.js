const logger = require('../utils/logger');
const config = require('../config');
const difyApi = require('../infrastructure/dify/api');
const { sendResult } = require('../infrastructure/bullmq/resultQueue');
const BillingService = require('../services/BillingService');

/**
 * Процессор для Fast Lane (интерактивные задачи)
 * @param {Job} job - Задача из BullMQ
 * @returns {Promise<any>} Результат выполнения задачи
 */
async function fastLaneProcessor(job) {
  logger.info('Fast job processing', {
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });

  // Обработка различных типов задач
  switch (job.name) {
    case 'CMD_TRANSLATE':
      return await handleTranslate(job);
    // TODO: Реализовать обработку других типов задач
    // case 'CMD_GEN_RESPONSE':
    //   return await handleGenResponse(job);
    // case 'CMD_ANALYZE_NEW_TICKET':
    //   return await handleAnalyzeNewTicket(job);
    // ...
    default:
      logger.warn('Unknown job type in fast lane', {
        jobId: job.id,
        jobName: job.name,
      });
      return { status: 'unknown_command', jobId: job.id };
  }
}

/**
 * Обработка команды перевода текста
 * @param {Job} job - Задача перевода
 * @returns {Promise<void>}
 */
async function handleTranslate(job) {
  const { text, targetLang, lang, meta = {} } = job.data;

  logger.info('CMD_TRANSLATE: Starting translation', {
    jobId: job.id,
    textLength: text?.length,
    targetLang,
  });

  try {
    // Подготовка данных для Dify Workflow
    const inputs = {
      text: text,
      // Маппинг targetLang в lang (как требует YAML)
      lang: targetLang || lang || 'en'
    };

    // Получаем API ключ для сервиса перевода
    const apiKey = config.dify.keys.translator;

    // Вызываем Dify Workflow для перевода
    const result = await difyApi.runWorkflow(apiKey, inputs, meta.user || 'system');

    // Извлекаем переведенный текст из результата
    // Workflow обычно возвращает результат в outputs.text или outputs.result
    const translatedText = result.data?.outputs?.text ||
                          result.data?.outputs?.result ||
                          result.data?.outputs?.answer ||
                          result.data?.answer ||
                          result.data?.text ||
                          result.data?.result ||
                          '';

    // Извлечение usage через BillingService
    const usage = BillingService.extractUsage(result);

  logger.info('CMD_TRANSLATE: Translation completed', {
    jobId: job.id,
    originalLength: text?.length || 0,
    translatedLength: translatedText?.length || 0,
    targetLang: inputs.lang,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      ...(usage.model && { model: usage.model }),
    },
  });

  const responseResult = {
    success: true,
    data: {
      original: text,
      translated: translatedText,
      targetLang: inputs.lang,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        ...(usage.model && { model: usage.model }),
        stages: [usage], // Единичный этап для этой операции
      },
    },
  };

    await sendResult('CMD_TRANSLATE', responseResult, meta);
  } catch (error) {
    logger.error('CMD_TRANSLATE: Translation failed', {
      jobId: job.id,
      error: error.message,
      stack: error.stack,
    });

    throw error;
  }
}

module.exports = fastLaneProcessor;
