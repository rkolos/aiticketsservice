require('dotenv').config({ override: true });
const difyApi = require('./src/infrastructure/dify/api');

async function testIndexingTokens() {
  try {
    const adminKey = process.env.DIFY_APP_KEY_ADMIN;

    console.log('Testing batch status API...');

    // Тестируем получение статуса batch (используйте реальный batch ID из логов)
    const batchId = '20251210201240204213'; // пример из логов uploadFile
    console.log(`Getting batch status for ${batchId}...`);
    const batchStatus = await difyApi.getBatchStatus(adminKey, batchId);
    console.log('Batch status:', JSON.stringify(batchStatus, null, 2));

  } catch (error) {
    console.error('Test failed:', error.message);
    console.error('Full error:', error);
  }
}

testIndexingTokens();
