/**
 * Утилита для усечения длинных строковых полей при логировании объектов
 * Рекурсивно обходит объект и обрезает строки в указанных ключах до заданной длины
 * 
 * @param {any} obj - Объект для обработки
 * @param {Object} options - Опции обработки
 * @param {number} options.maxLength - Максимальная длина строки (по умолчанию 150)
 * @param {string[]} options.keysToTrim - Ключи для обрезки (по умолчанию: ['content', 'text', 'answer', 'records'])
 * @param {number} options.maxDepth - Максимальная глубина рекурсии (по умолчанию 10)
 * @returns {any} Обработанный объект
 */
function trimLogObject(obj, options = {}) {
  const {
    maxLength = 150,
    keysToTrim = ['content', 'text', 'answer', 'records'],
    maxDepth = 10,
  } = options;

  // Если достигли максимальной глубины, возвращаем объект как есть
  if (maxDepth <= 0) {
    return obj;
  }

  // Обработка null и undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Обработка примитивных типов
  if (typeof obj !== 'object') {
    return obj;
  }

  // Обработка массивов
  if (Array.isArray(obj)) {
    return obj.map(item => trimLogObject(item, {
      ...options,
      maxDepth: maxDepth - 1,
    }));
  }

  // Обработка объектов
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Если ключ в списке для обрезки и значение - строка
    if (keysToTrim.includes(key) && typeof value === 'string') {
      // Обрезаем строку, если она превышает maxLength
      if (value.length > maxLength) {
        result[key] = value.substring(0, maxLength) + '...[truncated]';
      } else {
        result[key] = value;
      }
    }
    // Если значение - массив и ключ 'records', обрабатываем вложенный контент
    else if (key === 'records' && Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'object' && item !== null) {
          const trimmedItem = { ...item };
          // Обрезаем строковые поля в элементах массива
          for (const field of keysToTrim) {
            if (typeof trimmedItem[field] === 'string' && trimmedItem[field].length > maxLength) {
              trimmedItem[field] = trimmedItem[field].substring(0, maxLength) + '...[truncated]';
            }
          }
          return trimLogObject(trimmedItem, {
            ...options,
            maxDepth: maxDepth - 1,
          });
        }
        return item;
      });
    }
    // Рекурсивная обработка вложенных объектов
    else if (typeof value === 'object' && value !== null) {
      result[key] = trimLogObject(value, {
        ...options,
        maxDepth: maxDepth - 1,
      });
    }
    // Остальные значения копируем как есть
    else {
      result[key] = value;
    }
  }

  return result;
}

module.exports = {
  trimLogObject,
};

