module.exports = [
  require('@eslint/js').configs.recommended,
  require('eslint-config-prettier'),
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        // Node.js built-in globals
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        Buffer: 'readonly',
        // Timer functions
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        // Other Node.js globals
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],
      quotes: ['error', 'single'],
    },
  },
  // Специальные правила для тестовых и скриптовых файлов
  {
    files: ['scripts/**/*.js', 'tests/**/*.js', '**/*.test.js'],
    rules: {
      'no-unused-vars': [
        'warn', // Предупреждение вместо ошибки для тестовых файлов
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }], // Разрешаем пустые catch в тестах
    },
  },
];

