const axios = require('axios');

async function testFileUpload() {
  console.log('🧪 Testing file upload to Dify...\n');

  const baseURL = 'http://localhost:5001/v1';
  const apiKey = 'dataset-7ZzvYVbCNbUNXiA74cB9kIRA';
  
  try {
    // Получить список датасетов
    console.log('📋 Getting datasets...');
    const datasetsResponse = await axios.get(`${baseURL}/datasets`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    const datasets = datasetsResponse.data.data || [];
    console.log(`✅ Found ${datasets.length} datasets`);
    
    if (datasets.length === 0) {
      console.log('❌ No datasets found');
      return;
    }
    
    const datasetId = datasets[0].id;
    console.log(`📋 Using dataset: ${datasetId}`);
    
    // Скачать файл
    console.log('📋 Downloading file...');
    const fileUrl = 'https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md';
    const fileResponse = await axios.get(fileUrl, { responseType: 'stream' });
    
    console.log(`✅ File downloaded, size: ${fileResponse.headers['content-length']}`);
    
    // Загрузить файл в Dify
    console.log('📋 Uploading to Dify...');
    const FormData = require('form-data');
    const formData = new FormData();
    
    formData.append('file', fileResponse.data, {
      filename: 'alpaca-webui-readme.md',
      contentType: 'text/plain'
    });
    
    const dataField = JSON.stringify({
      indexing_technique: 'high_quality',
      process_rule: {
        mode: 'automatic',
        rules: {}
      }
    });
    formData.append('data', dataField);
    
    const uploadResponse = await axios.post(
      `${baseURL}/datasets/${datasetId}/document/create_by_file`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 30000
      }
    );
    
    console.log('✅ File uploaded successfully');
    console.log('📋 Response:', JSON.stringify(uploadResponse.data, null, 2));
    
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
    if (error.response?.status) {
      console.log('📋 Status:', error.response.status);
    }
  }
}

testFileUpload();
