#!/usr/bin/env node

/**
 * Тестовый скрипт для вызова классификатора Dify
 * 
 * Использование:
 *   node scripts/test-classifier.js [API_KEY] [MESSAGE]
 * 
 *   или через переменную окружения:
 *   DIFY_KEY_CLASSIFIER=your-key node scripts/test-classifier.js "Ваше сообщение"
 * 
 * Требует настройки переменных окружения в .env файле:
 *   - DIFY_API_URL (по умолчанию: http://localhost:5001/v1)
 */

require('dotenv').config();

// Устанавливаем переменные окружения ДО загрузки модулей, которые требуют валидацию
const apiKey = process.argv[2] || process.env.DIFY_KEY_CLASSIFIER;
const testMessage = process.argv[3] || process.env.TEST_MESSAGE;

if (apiKey) {
  process.env.DIFY_KEY_CLASSIFIER = apiKey;
}
// Устанавливаем минимальные переменные для обхода валидации
if (!process.env.REDIS_HOST) {
  process.env.REDIS_HOST = 'localhost';
}
if (!process.env.DIFY_KEY_ADMIN) {
  process.env.DIFY_KEY_ADMIN = 'test-admin-key';
}
if (!process.env.DIFY_KEY_CLASSIFIER) {
  process.env.DIFY_KEY_CLASSIFIER = apiKey || 'test-classifier-key';
}
if (!process.env.DIFY_KEY_SUMMARIZER) {
  process.env.DIFY_KEY_SUMMARIZER = 'test-summarizer-key';
}
if (!process.env.DIFY_KEY_RESPONSE_WORKFLOW) {
  process.env.DIFY_KEY_RESPONSE_WORKFLOW = 'test-response-key';
}

const axios = require('axios');
const { cleanLlmJson } = require('../src/utils/llmParser');

// Получение конфигурации (можно переопределить через аргументы или env vars)
const apiUrl = process.env.DIFY_API_URL || 'http://localhost:5001/v1';

// Тестовые сообщения для классификации
const defaultTestMessages = [
  'Здравствуйте! У меня проблема с входом в систему. Не могу авторизоваться уже второй день.',
  'Спасибо за быструю помощь! Всё работает отлично, проблема решена.',
  'Не могу скачать файл, постоянно выдает ошибку 404.',
  'Приложение работает идеально, всё как надо!',
  'Ужасный сервис, ничего не работает, требую возврата денег!',
];

async function testClassifier() {
  try {
    console.log('🚀 Тестирование классификатора Dify...\n');

    // Проверка конфигурации
    if (!apiKey) {
      console.error('❌ Ошибка: DIFY_KEY_CLASSIFIER не указан.\n');
      console.log('Укажите ключ одним из способов:');
      console.log('  1. В .env файле: DIFY_KEY_CLASSIFIER=your-key');
      console.log('  2. Через аргумент: node scripts/test-classifier.js your-key "сообщение"');
      console.log('  3. Через переменную: DIFY_KEY_CLASSIFIER=your-key node scripts/test-classifier.js\n');
      process.exit(1);
    }

    // Выбор тестового сообщения
    const message = testMessage || defaultTestMessages[0];
    const targetLanguage = process.env.TARGET_LANGUAGE || 'ru';

    console.log('✅ Конфигурация:');
    console.log(`   API URL: ${apiUrl}`);
    console.log(`   Classifier Key: ${apiKey.substring(0, 20)}...`);
    console.log(`   Target Language: ${targetLanguage}\n`);

    console.log('📝 Тестовое сообщение:');
    console.log('─'.repeat(60));
    console.log(message);
    console.log('─'.repeat(60));
    console.log();

    // Создание клиента для Dify API
    const difyClient = axios.create({
      baseURL: apiUrl,
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    // Вызов классификатора
    console.log('🔄 Вызов классификатора Dify...');
    const startTime = Date.now();
    
    const response = await difyClient.post('/workflows/run', {
      inputs: {
        message: message,
        language: targetLanguage,
      },
      response_mode: 'blocking',
      user: 'test-user-' + Date.now(),
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Классификация завершена за ${duration}ms\n`);

    // Получение результата
    const fullResponse = response.data;
    const outputs = fullResponse.data?.outputs || fullResponse.outputs || fullResponse;
    
    console.log('📄 Сырой ответ от API:');
    console.log('─'.repeat(60));
    console.log(JSON.stringify(fullResponse, null, 2));
    console.log('─'.repeat(60));
    console.log();

    // Парсинг JSON из ответа
    console.log('🔍 Парсинг JSON ответа...');
    
    let parsedResult;
    let jsonText;

    // Извлечение JSON текста из ответа (приоритет по порядку)
    if (outputs && typeof outputs === 'object') {
      // Ищем JSON в поле outputs.text (стандартный путь для Dify Workflow)
      if (outputs.text && typeof outputs.text === 'string') {
        jsonText = outputs.text;
      } else if (outputs.output && typeof outputs.output === 'string') {
        jsonText = outputs.output;
      } else if (outputs.result && typeof outputs.result === 'string') {
        jsonText = outputs.result;
      } else if (outputs.json && typeof outputs.json === 'string') {
        jsonText = outputs.json;
      } else if (typeof outputs === 'string') {
        jsonText = outputs;
      } else {
        // Если не нашли строку, преобразуем весь объект в JSON
        jsonText = JSON.stringify(outputs);
      }
    } else if (typeof outputs === 'string') {
      jsonText = outputs;
    } else {
      jsonText = String(outputs);
    }
    
    // Проверяем, что jsonText действительно строка
    if (typeof jsonText !== 'string') {
      jsonText = JSON.stringify(jsonText);
    }

    // Очистка JSON от Markdown оберток
    try {
      const cleanedJson = cleanLlmJson(jsonText);
      parsedResult = JSON.parse(cleanedJson);
      
      console.log('✅ JSON успешно распарсен\n');
      
      // Валидация результата
      if (!parsedResult.title) {
        console.warn('⚠️  Предупреждение: поле "title" отсутствует в результате');
      }
      
      if (!parsedResult.sentiment) {
        console.warn('⚠️  Предупреждение: поле "sentiment" отсутствует в результате');
      }

      // Вывод результата
      console.log('📊 Результат классификации:');
      console.log('═'.repeat(60));
      console.log(`Название (title): ${parsedResult.title || '(не указано)'}`);
      console.log(`Эмоциональная окраска (sentiment): ${parsedResult.sentiment || '(не указано)'}`);
      
      if (Object.keys(parsedResult).length > 2) {
        console.log('\nДополнительные поля:');
        Object.keys(parsedResult).forEach(key => {
          if (key !== 'title' && key !== 'sentiment') {
            console.log(`  ${key}: ${JSON.stringify(parsedResult[key])}`);
          }
        });
      }
      
      console.log('═'.repeat(60));
      
    } catch (parseError) {
      console.error('❌ Ошибка при парсинге JSON:');
      console.error(`   ${parseError.message}`);
      console.error('\nСырой текст для парсинга:');
      console.error('─'.repeat(60));
      console.error(jsonText.substring(0, 500));
      if (jsonText.length > 500) {
        console.error(`\n... (ещё ${jsonText.length - 500} символов)`);
      }
      console.error('─'.repeat(60));
      throw parseError;
    }

    console.log('\n✅ Тест успешно завершён!');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Ошибка при тестировании классификатора:');
    console.error('─'.repeat(60));
    
    if (error.response) {
      // Ошибка от API
      console.error(`Статус: ${error.response.status}`);
      console.error(`Сообщение: ${error.response.data?.message || error.message}`);
      if (error.response.data) {
        console.error('\nДетали ответа:');
        console.error(JSON.stringify(error.response.data, null, 2));
      }
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error(`Ошибка подключения: ${error.message}`);
      console.error(`Проверьте, что Dify API доступен по адресу: ${apiUrl}`);
    } else if (error.message) {
      console.error(error.message);
      if (error.stack && (process.env.DEBUG || error.code)) {
        console.error('\nДетали ошибки:');
        if (error.code) console.error(`Код ошибки: ${error.code}`);
        if (error.config) {
          console.error(`URL: ${error.config.url || 'N/A'}`);
          console.error(`Method: ${error.config.method || 'N/A'}`);
        }
        if (process.env.DEBUG && error.stack) {
          console.error('\nСтек ошибки:');
          console.error(error.stack);
        }
      }
    } else {
      console.error(error);
    }
    
    console.error('─'.repeat(60));
    process.exit(1);
  }
}

// Запуск теста
testClassifier();

