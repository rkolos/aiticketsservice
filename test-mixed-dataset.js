const axios = require('axios');

async function testMixedDataset() {
  console.log('🧪 Testing mixed dataset with both files...\n');

  const baseURL = 'http://localhost:5001/v1';
  const apiKey = 'dataset-7ZzvYVbCNbUNXiA74cB9kIRA';
  const datasetId = 'd9482c1a-164c-4874-b2de-bad2be2bf66f'; // Mixed dataset
  
  const files = [
    { url: 'https://raw.githubusercontent.com/open-webui/open-webui/main/README.md', name: 'open-webui-readme.md' },
    { url: 'https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md', name: 'alpaca-webui-readme.md' }
  ];

  for (const file of files) {
    try {
      console.log(`📋 Processing: ${file.name}`);

      // Скачать файл
      const fileResponse = await axios.get(file.url, { responseType: 'stream' });
      
      // Загрузить файл
      const FormData = require('form-data');
      const formData = new FormData();
      
      formData.append('file', fileResponse.data, {
        filename: file.name,
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
      
      console.log(`✅ ${file.name} uploaded successfully!`);
      console.log(`   doc_form: ${uploadResponse.data.document.doc_form}`);
      
    } catch (error) {
      console.log(`❌ ${file.name} failed:`, error.response?.data?.message || error.message);
      if (error.response?.data?.message?.includes('doc_form')) {
        console.log('   This is the doc_form error we are trying to solve');
      }
    }
  }
}

testMixedDataset();
