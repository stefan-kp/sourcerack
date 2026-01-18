import { describe, it, expect, beforeAll } from 'vitest';
import { PythonExtractor } from '../../../src/sqi/extractors/python.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { initializeTreeSitter, parseCode } from '../../../src/parser/tree-sitter.js';

describe('PythonExtractor', () => {
  const extractor = new PythonExtractor();

  beforeAll(async () => {
    await initializeTreeSitter();
  });

  describe('Symbol Extraction', () => {
    it('should extract function definitions', () => {
      const code = `
def greet(name: str) -> str:
    """Return a greeting message."""
    return f"Hello, {name}!"
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'test.py', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]?.name).toBe('greet');
      expect(result.symbols[0]?.symbol_kind).toBe(SymbolKind.FUNCTION);
      expect(result.symbols[0]?.parameters).toHaveLength(1);
      expect(result.symbols[0]?.parameters?.[0]?.name).toBe('name');
      expect(result.symbols[0]?.parameters?.[0]?.type_annotation).toBe('str');
    });

    it('should extract class definitions', () => {
      const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str):
        """Fetch a user by ID."""
        return self.db.find(user_id)
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'service.py', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'UserService');
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.symbol_kind).toBe(SymbolKind.CLASS);
      expect(classSymbol?.docstring?.description).toContain('Service for managing users');

      // Check children
      expect(classSymbol?.children).toBeDefined();
      expect(classSymbol?.children?.length).toBe(2);

      const initMethod = classSymbol?.children?.find((c) => c.name === '__init__');
      expect(initMethod).toBeDefined();
      expect(initMethod?.symbol_kind).toBe(SymbolKind.METHOD);

      const getUser = classSymbol?.children?.find((c) => c.name === 'get_user');
      expect(getUser).toBeDefined();
      expect(getUser?.docstring?.description).toContain('Fetch a user by ID');
    });

    it('should extract decorated functions', () => {
      const code = `
@staticmethod
def helper():
    pass

@classmethod
def from_config(cls, config):
    pass
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'utils.py', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(2);

      const helper = result.symbols.find((s) => s.name === 'helper');
      expect(helper).toBeDefined();
      expect(helper?.is_static).toBe(true);

      const fromConfig = result.symbols.find((s) => s.name === 'from_config');
      expect(fromConfig).toBeDefined();
    });

    it('should extract async functions', () => {
      const code = `
async def fetch_data(url: str) -> dict:
    """Fetch data from URL."""
    response = await http_get(url)
    return response.json()
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'async.py', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]?.name).toBe('fetch_data');
      expect(result.symbols[0]?.is_async).toBe(true);
    });

    it('should extract module-level constants', () => {
      const code = `
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30.0
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'config.py', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(2);

      const maxRetries = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      expect(maxRetries).toBeDefined();
      expect(maxRetries?.symbol_kind).toBe(SymbolKind.CONSTANT);
    });

    it('should handle various parameter types', () => {
      const code = `
def complex_func(
    required: str,
    optional: int = 10,
    *args,
    **kwargs
) -> None:
    pass
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'params.py', code);

      expect(result.success).toBe(true);
      const func = result.symbols[0];
      expect(func?.parameters).toBeDefined();

      const params = func?.parameters ?? [];
      expect(params.length).toBeGreaterThanOrEqual(2);

      const required = params.find((p) => p.name === 'required');
      expect(required?.is_optional).toBe(false);

      const optional = params.find((p) => p.name === 'optional');
      expect(optional?.is_optional).toBe(true);
    });

    it('should handle visibility conventions', () => {
      const code = `
def public_method():
    pass

def _private_method():
    pass

def __very_private():
    pass
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'visibility.py', code);

      expect(result.success).toBe(true);

      const publicMethod = result.symbols.find((s) => s.name === 'public_method');
      expect(publicMethod?.visibility).toBe('public');

      const privateMethod = result.symbols.find((s) => s.name === '_private_method');
      expect(privateMethod?.visibility).toBe('private');
    });
  });

  describe('Usage Extraction', () => {
    it('should extract function calls', () => {
      const code = `
from utils import process_data

result = process_data(input_value)
print(result)
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'app.py', code);

      expect(result.success).toBe(true);
      const calls = result.usages.filter((u) => u.usage_type === 'call');
      expect(calls.some((u) => u.symbol_name === 'process_data')).toBe(true);
    });

    it('should extract class inheritance', () => {
      const code = `
class CustomError(Exception):
    pass

class MyClass(BaseClass):
    pass
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'classes.py', code);

      expect(result.success).toBe(true);
      const extendsUsages = result.usages.filter((u) => u.usage_type === 'extend');
      expect(extendsUsages.some((u) => u.symbol_name === 'Exception')).toBe(true);
      expect(extendsUsages.some((u) => u.symbol_name === 'BaseClass')).toBe(true);
    });

    it('should not extract definition names as usages', () => {
      const code = `
def my_function():
    return 42
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'test.py', code);

      expect(result.success).toBe(true);
      // my_function should not be in usages since it's a definition
      const myFuncUsages = result.usages.filter((u) => u.symbol_name === 'my_function');
      expect(myFuncUsages).toHaveLength(0);
    });
  });

  describe('Import Extraction', () => {
    it('should extract simple imports', () => {
      const code = `
import os
import sys
import json
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'imports.py', code);

      expect(result.success).toBe(true);
      expect(result.imports.length).toBeGreaterThanOrEqual(3);

      const osImport = result.imports.find((i) => i.module_specifier === 'os');
      expect(osImport).toBeDefined();
      expect(osImport?.import_type).toBe('python');
    });

    it('should extract from imports', () => {
      const code = `
from typing import List, Dict, Optional
from pathlib import Path
from collections import defaultdict
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'imports.py', code);

      expect(result.success).toBe(true);

      const typingImport = result.imports.find((i) => i.module_specifier === 'typing');
      expect(typingImport).toBeDefined();
      expect(typingImport?.bindings.length).toBeGreaterThanOrEqual(3);
      expect(typingImport?.bindings.some((b) => b.imported_name === 'List')).toBe(true);
    });

    it('should handle aliased imports', () => {
      const code = `
import numpy as np
from pandas import DataFrame as DF
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'imports.py', code);

      expect(result.success).toBe(true);

      const npImport = result.imports.find((i) =>
        i.bindings.some((b) => b.local_name === 'np')
      );
      expect(npImport).toBeDefined();
    });

    it('should handle wildcard imports', () => {
      const code = `
from module import *
`;
      const tree = parseCode(code, 'python');
      const result = extractor.extract(tree, 'imports.py', code);

      expect(result.success).toBe(true);
      const wildcardImport = result.imports.find((i) =>
        i.bindings.some((b) => b.imported_name === '*')
      );
      expect(wildcardImport).toBeDefined();
    });
  });
});
