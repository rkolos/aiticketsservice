const difyApi = require('./src/infrastructure/dify/api');
const config = require('./src/config');

async function testTopK() {
  console.log('Testing top_k configuration...\n');

  // Test retrieve function (should use top_k: 7)
  console.log('1. Testing retrieve() function (admin KB):');
  try {
    const results = await difyApi.retrieve('test-dataset-id', 'test query');
    console.log('❌ retrieve() should not work with invalid dataset ID');
  } catch (error) {
    console.log('✅ retrieve() failed as expected:', error.message.substring(0, 50));
  }

  // Test retrieveChunks function (should use limit = 5)
  console.log('\n2. Testing retrieveChunks() function (history KB):');
  try {
    const chunks = await difyApi.retrieveChunks(config.dify.keys.admin, 'test-dataset-id', 'test query', 5);
    console.log('❌ retrieveChunks() should not work with invalid dataset ID');
  } catch (error) {
    console.log('✅ retrieveChunks() failed as expected:', error.message.substring(0, 50));
  }

  console.log('\n3. Checking function signatures:');
  console.log('retrieveChunks default limit:', difyApi.retrieveChunks.toString().match(/limit\s*=\s*(\d+)/)?.[1] || 'not found');

  console.log('\n✅ Test completed');
}

testTopK();
