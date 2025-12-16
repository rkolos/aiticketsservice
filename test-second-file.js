const axios = require('axios');

async function testSecondFile() {
  console.log('🧪 Testing second file upload to new dataset...\n');

  const baseURL = 'http://localhost:5001/v1';
  const apiKey = 'dataset-7ZzvYVbCNbUNXiA74cB9kIRA';
  const datasetId = '73f0ac90-eaa2-4e58-81ba-15808f2e9d78'; // Новый датасет
  
  try {
    // Скачать файл
    console.log('📋 Downloading Alpaca WebUI README...');
    const fileUrl = 'https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md';
    const fileResponse = await axios.get(fileUrl, { responseType: 'stream' });
    
    console.log(`✅ File downloaded, size: ${fileResponse.headers['content-length']}`);
    
    // Загрузить файл в новый датасет
    console.log('📋 Uploading to new dataset...');
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
    
    console.log('✅ File uploaded successfully to new dataset!');
    console.log('📋 Response:', JSON.stringify(uploadResponse.data, null, 2));
    
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
    if (error.response?.status) {
      console.log('📋 Status:', error.response.status);
    }
  }
}

testSecondFile();
