/* eslint-disable no-console */
// Простая smoke-прога для Dify:
// 1) Создаёт временный датасет
// 2) Загружает все about/*.md как документы
// 3) Делает retrieval и вызывает workflow ответа с найденным контекстом
// 4) Печатает ответ
// 5) Чистит за собой (удаляет датасет)

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const difyApi = require('../src/infrastructure/dify/api');

const ADMIN_KEY = config.dify.keys.admin;
const WORKFLOW_KEY = config.dify.keys.responseWorkflow;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAboutFiles() {
  const dir = path.resolve(__dirname, '../about');
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  return entries.map((file) => ({
    name: file,
    text: fs.readFileSync(path.join(dir, file), 'utf-8'),
  }));
}

async function main() {
  if (!ADMIN_KEY || !WORKFLOW_KEY) {
    throw new Error('DIFY_KEY_ADMIN or DIFY_KEY_RESPONSE_WORKFLOW is missing');
  }

  const files = readAboutFiles();
  if (files.length === 0) {
    throw new Error('No about/*.md files found');
  }

  const datasetName = `about-smoke-${Date.now()}`;
  let datasetId;

  try {
    console.log(`Создаю датасет: ${datasetName}`);
    const ds = await difyApi.createDataset(ADMIN_KEY, datasetName);
    datasetId = ds.id;
    console.log(`Датасет создан: ${datasetId}`);

    // Загрузка документов
    for (const file of files) {
      console.log(`Добавляю документ: ${file.name}`);
      await difyApi.createDocumentByText(ADMIN_KEY, datasetId, file.name, file.text);
    }

    // Небольшая пауза на индексацию
    await sleep(1500);

    const question = 'Briefly describe the architecture and main modules of Ticket-AI-Worker';
    console.log(`Делаю retrieval по вопросу: "${question}"`);
    const chunks = await difyApi.retrieveChunks(ADMIN_KEY, datasetId, question, 5);

    const context = chunks
      .map((c, idx) => {
        const content =
          c.content ||
          (c.segment && (c.segment.content || c.segment.text)) ||
          c.text ||
          (c.document && (c.document.content || c.document.text)) ||
          (c.record && (c.record.content || c.record.text)) ||
          (typeof c === 'string' ? c : JSON.stringify(c));
        return `DOC${idx + 1}: ${content}`;
      })
      .join('\n');

    const contextPath = path.resolve(__dirname, 'dify-context-last.txt');
    fs.writeFileSync(contextPath, context, 'utf-8');

    console.log('\n----- КОНТЕКСТ (первые 1200 символов) -----\n');
    console.log(context.slice(0, 1200));
    if (context.length > 1200) {
      console.log('\n... [truncated]');
    }
    console.log('\n------------------------------------------\n');

    const history =
      'User: Мне нужно понять архитектуру и основные модули Ticket-AI-Worker\n' +
      'Assistant: Я уточню детали и вернусь с кратким описанием.';

    console.log('Вызываю workflow ответа...');
    const outputs = await difyApi.runWorkflow(
      WORKFLOW_KEY,
      {
        query: question,
        history,
        context,
        language: 'en', // Передаем английский язык для проверки
      },
      'smoke-script'
    );

    const answer =
      outputs.text ||
      outputs.output ||
      outputs.answer ||
      outputs.response ||
      JSON.stringify(outputs);

    console.log('\n===== ОТВЕТ WORKFLOW =====\n');
    console.log(answer);
    console.log('\n==========================\n');
  } finally {
    if (datasetId) {
      console.log(`Удаляю датасет: ${datasetId}`);
      await difyApi.deleteDataset(ADMIN_KEY, datasetId);
    }
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});

