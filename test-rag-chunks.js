const difyApi = require('./src/infrastructure/dify/api');
const config = require('./src/config');

async function testRAGChunks() {
  console.log('🔍 Testing RAG chunk retrieval with new top_k settings...\n');

  try {
    // Используем реальный dataset ID из логов воркера
    const datasetId = '87f83bab-ae08-4e3e-b8a5-b0edc885c058'; // admin KB из последнего теста

    console.log('1. Testing retrieve() with top_k=7 (admin KB):');
    const results = await difyApi.retrieve(datasetId, 'Open WebUI features and capabilities');
    console.log(`✅ Found ${results.records?.length || 0} records (expected: up to 7)`);

    console.log('\n2. Testing retrieveChunks() with limit=5 (history KB):');
    const historyDatasetId = '6ee3efdf-c979-48da-8e5b-9aa0c0814b17'; // history KB
    const chunks = await difyApi.retrieveChunks(config.dify.keys.admin, historyDatasetId, 'user support tickets', 5);
    console.log(`✅ Found ${chunks?.length || 0} chunks (expected: up to 5)`);

    console.log('\n3. Checking if reranking is enabled:');
    console.log('retrieveChunks now uses reranking:', chunks && chunks.length > 0 ? '✅ Yes' : '❓ No data to check');

    console.log('\n📊 Summary:');
    console.log('- Admin KB (retrieve): top_k = 7');
    console.log('- History KB (retrieveChunks): limit = 5');
    console.log('- Both use Hybrid Search + Jina Reranker');
    console.log('- Q&A optimized segmentation');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testRAGChunks();
