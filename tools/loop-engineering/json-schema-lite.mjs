function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'boolean') return typeof value === 'boolean';
  return false;
}

function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`;
}

export function validateJsonSchema(value, schema) {
  const errors = [];

  function fail(path, keyword, message) {
    errors.push({ path, keyword, message });
  }

  function visit(current, rule, currentPath) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      fail(currentPath, 'schema', 'Schema node must be an object.');
      return;
    }

    if ('$ref' in rule) {
      fail(currentPath, '$ref', 'External or local $ref is not supported by the Phase A validator.');
      return;
    }

    const expectedTypes = rule.type === undefined
      ? null
      : Array.isArray(rule.type) ? rule.type : [rule.type];

    if (expectedTypes && !expectedTypes.some(type => matchesType(current, type))) {
      fail(currentPath, 'type', `Expected ${expectedTypes.join(' | ')}, got ${describeType(current)}.`);
      return;
    }

    if ('const' in rule && stableKey(current) !== stableKey(rule.const)) {
      fail(currentPath, 'const', `Value must equal ${JSON.stringify(rule.const)}.`);
    }

    if (Array.isArray(rule.enum) && !rule.enum.some(candidate => stableKey(candidate) === stableKey(current))) {
      fail(currentPath, 'enum', `Value is not one of the allowed enum values.`);
    }

    if (typeof current === 'string') {
      if (Number.isInteger(rule.minLength) && current.length < rule.minLength) {
        fail(currentPath, 'minLength', `String length must be >= ${rule.minLength}.`);
      }
      if (Number.isInteger(rule.maxLength) && current.length > rule.maxLength) {
        fail(currentPath, 'maxLength', `String length must be <= ${rule.maxLength}.`);
      }
      if (typeof rule.pattern === 'string') {
        let expression;
        try {
          expression = new RegExp(rule.pattern);
        } catch (error) {
          fail(currentPath, 'pattern', `Invalid schema regex: ${error.message}`);
          expression = null;
        }
        if (expression && !expression.test(current)) {
          fail(currentPath, 'pattern', `String does not match ${rule.pattern}.`);
        }
      }
    }

    if (typeof current === 'number' && Number.isFinite(current)) {
      if (typeof rule.minimum === 'number' && current < rule.minimum) {
        fail(currentPath, 'minimum', `Number must be >= ${rule.minimum}.`);
      }
      if (typeof rule.maximum === 'number' && current > rule.maximum) {
        fail(currentPath, 'maximum', `Number must be <= ${rule.maximum}.`);
      }
    }

    if (Array.isArray(current)) {
      if (Number.isInteger(rule.minItems) && current.length < rule.minItems) {
        fail(currentPath, 'minItems', `Array length must be >= ${rule.minItems}.`);
      }
      if (Number.isInteger(rule.maxItems) && current.length > rule.maxItems) {
        fail(currentPath, 'maxItems', `Array length must be <= ${rule.maxItems}.`);
      }
      if (rule.uniqueItems === true) {
        const seen = new Set();
        for (const [index, item] of current.entries()) {
          const key = stableKey(item);
          if (seen.has(key)) fail(`${currentPath}[${index}]`, 'uniqueItems', 'Array item must be unique.');
          seen.add(key);
        }
      }
      if (rule.items && typeof rule.items === 'object') {
        current.forEach((item, index) => visit(item, rule.items, `${currentPath}[${index}]`));
      }
    }

    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const properties = rule.properties && typeof rule.properties === 'object' ? rule.properties : {};
      for (const key of rule.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          fail(`${currentPath}.${key}`, 'required', 'Required property is missing.');
        }
      }

      if (rule.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            fail(`${currentPath}.${key}`, 'additionalProperties', 'Additional property is not allowed.');
          }
        }
      }

      for (const [key, childRule] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          visit(current[key], childRule, `${currentPath}.${key}`);
        }
      }
    }
  }

  visit(value, schema, '$');
  return { valid: errors.length === 0, errors };
}
