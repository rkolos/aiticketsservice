module.exports = [
  require('@eslint/js').configs.recommended,
  require('eslint-config-prettier'),
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'error',
      quotes: ['error', 'single'],
    },
  },
];

