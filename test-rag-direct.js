/* eslint-disable no-console */
/**
 * Прямой тест RAG через Dify API
 * Проверяем загрузку файла и поиск без воркеров
 */

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Настройки из .env
const DIFY_API_URL = process.env.DIFY_API_URL || 'http://localhost:5001/v1';
const DIFY_ADMIN_KEY = process.env.DIFY_KEY_ADMIN || 'dataset-zxpSgJYepLlTZLis064ShuA7';

const difyApi = axios.create({
  baseURL: DIFY_API_URL,
  headers: {
    'Authorization': `Bearer ${DIFY_ADMIN_KEY}`,
    'Content-Type': 'application/json',
  },
});

async function testRAGDirect() {
  console.log('🔍 ПРЯМОЙ ТЕСТ RAG ЧЕРЕЗ DIFY API\n');

  try {
    // Шаг 1: Получаем список существующих баз знаний
    console.log('1️⃣ Получаем список баз знаний...');
    const datasetsResponse = await difyApi.get('/datasets');
    const datasets = datasetsResponse.data.data || [];

    console.log(`📚 Найдено баз знаний: ${datasets.length}`);
    datasets.forEach(ds => console.log(`  - ${ds.name} (ID: ${ds.id})`));

    // Используем первую доступную базу знаний или создаем новую
    let datasetId;
    if (datasets.length > 0) {
      datasetId = datasets[0].id;
      console.log(`✅ Используем существующую базу знаний: ${datasets[0].name}`);
    } else {
      console.log('2️⃣ Создаем новую базу знаний...');
      const datasetResponse = await difyApi.post('/datasets', {
        name: `test-rag-dataset-${Date.now()}`,
        description: 'Тестовая база знаний для проверки RAG',
        permission: 'all_team_members',
        indexing_technique: 'high_quality',
        retrieval_model: {
          search_method: 'hybrid_search',
          reranking_enable: true,
          reranking_model: {
            reranking_provider_name: 'jina',
            reranking_model_name: 'jina-reranker-v2-base-multilingual'
          },
          top_k: 5,
          score_threshold: 0.0,
          score_threshold_enabled: false
        }
      });
      datasetId = datasetResponse.data.id;
      console.log(`✅ Создана база знаний: ${datasetId}`);
    }

    // Шаг 2: Проверяем документы в базе знаний
    console.log('2️⃣ Проверяем документы в базе знаний...');
    const documentsResponse = await difyApi.get(`/datasets/${datasetId}/documents`);
    const documents = documentsResponse.data.data || [];

    console.log(`📄 Найдено документов: ${documents.length}`);
    documents.forEach(doc => console.log(`  - ${doc.name} (${doc.word_count} слов, статус: ${doc.indexing_status})`));

    if (documents.length === 0) {
      console.log('⚠️ В базе знаний нет документов. Добавим тестовый документ...');

      // Добавляем тестовый документ с текстом
      const testContent = `# Open WebUI

Open WebUI is an extensible, feature-rich, and user-friendly self-hosted AI platform designed to operate entirely offline. It supports various LLM runners like Ollama and OpenAI-compatible APIs, with built-in inference engine for RAG, making it a powerful AI deployment solution.

## Key Features

- 🚀 Effortless Setup
- 🤝 Ollama/OpenAI API Integration
- 🛡️ Granular Permissions and User Groups
- 📱 Responsive Design
- 🛠️ Model Builder
- 📚 Local RAG Integration
- 🌐 Web Search for RAG
- 🎨 Image Generation Integration

## Image Generation Support

Open WebUI supports multiple image generation engines:
- OpenAI DALL-E
- Gemini
- ComfyUI (local)
- AUTOMATIC1111 (local)

This allows for both generation and prompt-based editing workflows.`;

      try {
        const uploadResponse = await difyApi.post(`/datasets/${datasetId}/documents`, {
          name: 'Open WebUI Test Document',
          text: testContent,
          indexing_technique: 'high_quality',
          process_rule: {
            mode: 'automatic'
          }
        });

        console.log('✅ Тестовый документ добавлен');
      } catch (uploadError) {
        console.warn(`⚠️ Не удалось добавить документ: ${uploadError.message}`);
      }

      // Ждем индексации
      console.log('⏳ Ждем индексации...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Шаг 3: Тестируем поиск
    console.log('3️⃣ Тестируем поиск в базе знаний...');

    const searchQueries = [
      'What is Open WebUI?',
      'Tell me about image generation',
      'Open WebUI features',
      'ComfyUI',
      'AUTOMATIC1111'
    ];

    for (const query of searchQueries) {
      console.log(`\n🔍 Поиск: "${query}"`);

      try {
        const retrieveResponse = await difyApi.post(`/datasets/${datasetId}/retrieve`, {
          query,
          retrieval_model: {
            search_method: 'hybrid_search',
            reranking_enable: true,
            reranking_model: {
              reranking_provider_name: 'jina',
              reranking_model_name: 'jina-reranker-v2-base-multilingual'
            },
            top_k: 5,
            score_threshold: 0.0,
            score_threshold_enabled: false
          }
        });

        const records = retrieveResponse.data.records || [];
        console.log(`📊 Найдено чанков: ${records.length}`);

        if (records.length > 0) {
          console.log('🎯 Топ чанки:');
          records.slice(0, 3).forEach((record, i) => {
            console.log(`${i + 1}. Score: ${record.score?.toFixed(3)}`);
            console.log(`   Content: ${record.segment?.content?.substring(0, 100)}...`);
          });
        } else {
          console.log('❌ Ничего не найдено');
        }
      } catch (error) {
        console.error(`❌ Ошибка поиска: ${error.message}`);
      }
    }

    // Шаг 4: Завершение
    console.log('\n✅ ПРЯМОЙ ТЕСТ RAG ЗАВЕРШЕН - Использовалась существующая база знаний');

    console.log('\n✅ ПРЯМОЙ ТЕСТ RAG ЗАВЕРШЕН');

  } catch (error) {
    console.error('❌ ОШИБКА В ТЕСТЕ:');
    console.error(error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// Запуск
if (require.main === module) {
  testRAGDirect().catch(console.error);
}

module.exports = { testRAGDirect };
