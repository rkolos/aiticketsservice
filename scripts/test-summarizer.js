#!/usr/bin/env node

/**
 * Тестовый скрипт для вызова суммаризатора Dify
 * 
 * Использование:
 *   node scripts/test-summarizer.js [API_KEY]
 * 
 *   или через переменную окружения:
 *   DIFY_KEY_SUMMARIZER=your-key node scripts/test-summarizer.js
 * 
 * Требует настройки переменных окружения в .env файле:
 *   - DIFY_API_URL (по умолчанию: http://localhost:5001/v1)
 */

require('dotenv').config();

// Устанавливаем переменные окружения ДО загрузки модулей, которые требуют валидацию
const apiKey = process.argv[2] || process.env.DIFY_KEY_SUMMARIZER;
if (apiKey) {
  process.env.DIFY_KEY_SUMMARIZER = apiKey;
}
// Устанавливаем минимальные переменные для обхода валидации
if (!process.env.REDIS_HOST) {
  process.env.REDIS_HOST = 'localhost';
}
if (!process.env.DIFY_KEY_ADMIN) {
  process.env.DIFY_KEY_ADMIN = 'test-admin-key';
}
if (!process.env.DIFY_KEY_CLASSIFIER) {
  process.env.DIFY_KEY_CLASSIFIER = 'test-classifier-key';
}
if (!process.env.DIFY_KEY_SUMMARIZER) {
  process.env.DIFY_KEY_SUMMARIZER = apiKey || 'test-summarizer-key';
}
if (!process.env.DIFY_KEY_RESPONSE_WORKFLOW) {
  process.env.DIFY_KEY_RESPONSE_WORKFLOW = 'test-response-key';
}

const axios = require('axios');
const { formatTicketHistory } = require('../src/utils/historyFormatter');

// Получение конфигурации (можно переопределить через аргументы или env vars)
const apiUrl = process.env.DIFY_API_URL || 'http://localhost:5001/v1';

// Тестовая история тикета для суммаризации
const testTicketHistory = [
  {
    role: 'user',
    content: 'Здравствуйте! У меня проблема с входом в систему. Не могу авторизоваться уже второй день.',
  },
  {
    role: 'assistant',
    content: 'Здравствуйте! Расскажите, пожалуйста, какую именно ошибку вы видите при попытке входа?',
  },
  {
    role: 'user',
    content: 'Выводится сообщение "Неверный логин или пароль", хотя я уверен, что ввожу правильные данные.',
  },
  {
    role: 'assistant',
    content: 'Понял. Давайте проверим несколько моментов. Во-первых, убедитесь, что у вас отключен Caps Lock. Также проверьте, нет ли лишних пробелов перед или после логина/пароля.',
  },
  {
    role: 'user',
    content: 'Да, я проверил всё это. Проблема остаётся.',
  },
  {
    role: 'assistant',
    content: 'Хорошо, тогда давайте сбросим ваш пароль. Я отправил вам ссылку для сброса на вашу электронную почту. Пожалуйста, проверьте почту и перейдите по ссылке.',
  },
  {
    role: 'user',
    content: 'Спасибо! Я получил письмо и успешно сбросил пароль. Теперь всё работает. Проблема решена!',
  },
  {
    role: 'assistant',
    content: 'Отлично! Рад, что проблема решена. Если возникнут ещё вопросы, обращайтесь. Хорошего дня!',
  },
];

async function testSummarizer() {
  try {
    console.log('🚀 Тестирование суммаризатора Dify...\n');

    // Проверка конфигурации
    if (!apiKey) {
      console.error('❌ Ошибка: DIFY_KEY_SUMMARIZER не указан.\n');
      console.log('Укажите ключ одним из способов:');
      console.log('  1. В .env файле: DIFY_KEY_SUMMARIZER=your-key');
      console.log('  2. Через аргумент: node scripts/test-summarizer.js your-key');
      console.log('  3. Через переменную: DIFY_KEY_SUMMARIZER=your-key node scripts/test-summarizer.js\n');
      process.exit(1);
    }

    console.log('✅ Конфигурация:');
    console.log(`   API URL: ${apiUrl}`);
    console.log(`   Summarizer Key: ${apiKey.substring(0, 20)}...\n`);

    // Форматирование истории тикета
    console.log('📝 Форматирование истории тикета...');
    const formattedHistory = formatTicketHistory(testTicketHistory);
    
    console.log('\n📋 Отформатированная история:');
    console.log('─'.repeat(60));
    console.log(formattedHistory);
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

    // Вызов суммаризатора
    console.log('🔄 Вызов суммаризатора Dify...');
    const startTime = Date.now();
    
    const response = await difyClient.post('/workflows/run', {
      inputs: {
        ticket_history: formattedHistory,
      },
      response_mode: 'blocking',
      user: 'test-user-' + Date.now(),
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Суммаризация завершена за ${duration}ms\n`);

    // Вывод результата
    console.log('📄 Результат суммаризации:');
    console.log('═'.repeat(60));
    
    const result = response.data.outputs || response.data;
    
    // Результат может быть в разных форматах в зависимости от workflow
    if (typeof result === 'string') {
      console.log(result);
    } else if (result && typeof result === 'object') {
      // Если результат - объект, ищем текстовое поле (summary, output, text и т.д.)
      const summaryText = 
        result.summary || 
        result.output || 
        result.text || 
        result.result ||
        JSON.stringify(result, null, 2);
      console.log(summaryText);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    
    console.log('═'.repeat(60));
    console.log('\n✅ Тест успешно завершён!');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Ошибка при тестировании суммаризатора:');
    console.error('─'.repeat(60));
    
    if (error.response) {
      // Ошибка от API
      console.error(`Статус: ${error.response.status}`);
      console.error(`Сообщение: ${error.response.data?.message || error.message}`);
      if (error.response.data) {
        console.error('\nДетали ответа:');
        console.error(JSON.stringify(error.response.data, null, 2));
      }
    } else if (error.message) {
      console.error(error.message);
      if (error.stack && process.env.DEBUG) {
        console.error('\nСтек ошибки:');
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    
    console.error('─'.repeat(60));
    process.exit(1);
  }
}

// Запуск теста
testSummarizer();
