const BillingService = require('../../../src/services/BillingService');

describe('BillingService', () => {
  describe('extractUsage', () => {
    it('должен возвращать нулевые значения для null', () => {
      const result = BillingService.extractUsage(null, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        model: 'gpt-4',
      });
    });

    it('должен возвращать нулевые значения для undefined', () => {
      const result = BillingService.extractUsage(undefined, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        model: 'gpt-4',
      });
    });

    it('должен извлекать usage из metadata.usage (стандартный путь для Chatflow)', () => {
      const difyResponse = {
        metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
          model_name: 'gpt-4o-mini',
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        model: 'gpt-4o-mini',
      });
    });

    it('должен извлекать usage из data.outputs.usage (альтернативный путь для Workflow)', () => {
      const difyResponse = {
        data: {
          outputs: {
            usage: {
              prompt_tokens: 200,
              completion_tokens: 100,
              total_tokens: 300,
            },
            model_name: 'gpt-4',
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        model: 'gpt-4',
      });
    });

    it('должен извлекать usage с верхнего уровня', () => {
      const difyResponse = {
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
        },
        model_name: 'gpt-3.5-turbo',
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 50,
        completion_tokens: 25,
        total_tokens: 75,
        model: 'gpt-3.5-turbo',
      });
    });

    it('должен использовать defaultModel, если model_name не найден', () => {
      const difyResponse = {
        metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4o-mini');

      expect(result.model).toBe('gpt-4o-mini');
    });

    it('должен нормализовать разные форматы usage (prompt/completion вместо prompt_tokens/completion_tokens)', () => {
      const difyResponse = {
        metadata: {
          usage: {
            prompt: 100,
            completion: 50,
            total: 150,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        model: 'gpt-4',
      });
    });

    it('должен нормализовать формат с input_tokens/output_tokens', () => {
      const difyResponse = {
        metadata: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        model: 'gpt-4',
      });
    });

    it('должен нормализовать формат с только tokens', () => {
      const difyResponse = {
        metadata: {
          usage: {
            tokens: 150,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.total_tokens).toBe(150);
      expect(result.prompt_tokens).toBe(0);
      expect(result.completion_tokens).toBe(0);
    });

    it('должен вычислять total_tokens как сумму, если total не указан', () => {
      const difyResponse = {
        metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.total_tokens).toBe(150);
    });

    it('должен возвращать нулевые значения, если usage не найден', () => {
      const difyResponse = {
        data: {
          outputs: {
            text: 'Some response',
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        model: 'gpt-4',
      });
    });

    it('должен возвращать нулевые значения, если usage не является объектом', () => {
      const difyResponse = {
        metadata: {
          usage: 'invalid',
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        model: 'gpt-4',
      });
    });

    it('должен извлекать model_name из metadata', () => {
      const difyResponse = {
        metadata: {
          model_name: 'gpt-4o',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.model).toBe('gpt-4o');
    });

    it('должен извлекать model_name из data.outputs', () => {
      const difyResponse = {
        data: {
          outputs: {
            model_name: 'gpt-3.5-turbo',
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.model).toBe('gpt-3.5-turbo');
    });

    it('должен извлекать model_name с верхнего уровня', () => {
      const difyResponse = {
        model_name: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.model).toBe('gpt-4o-mini');
    });

    it('должен корректно обрабатывать числовые значения как строки', () => {
      const difyResponse = {
        metadata: {
          usage: {
            prompt_tokens: '100',
            completion_tokens: '50',
            total_tokens: '150',
          },
        },
      };

      const result = BillingService.extractUsage(difyResponse, 'gpt-4');

      expect(result.prompt_tokens).toBe(100);
      expect(result.completion_tokens).toBe(50);
      expect(result.total_tokens).toBe(150);
    });
  });
});

