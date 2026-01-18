import { describe, it, expect, beforeAll } from 'vitest';
import { TypeScriptExtractor } from '../../../src/sqi/extractors/typescript.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { initializeTreeSitter, parseCode } from '../../../src/parser/tree-sitter.js';

describe('TypeScriptExtractor', () => {
  const extractor = new TypeScriptExtractor();

  beforeAll(async () => {
    await initializeTreeSitter();
  });

  describe('Symbol Extraction', () => {
    it('should extract function declarations', () => {
      const code = `
function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'test.ts', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]?.name).toBe('hello');
      expect(result.symbols[0]?.symbol_kind).toBe(SymbolKind.FUNCTION);
      expect(result.symbols[0]?.return_type).toBe('string');
      expect(result.symbols[0]?.parameters).toHaveLength(1);
      expect(result.symbols[0]?.parameters?.[0]?.name).toBe('name');
    });

    it('should extract class declarations', () => {
      const code = `
export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User> {
    return this.db.find(id);
  }
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'service.ts', code);

      expect(result.success).toBe(true);
      
      const classSymbol = result.symbols.find(s => s.name === 'UserService');
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.symbol_kind).toBe(SymbolKind.CLASS);
      expect(classSymbol?.is_exported).toBe(true);
      
      // Check children
      expect(classSymbol?.children).toBeDefined();
      expect(classSymbol?.children?.length).toBeGreaterThan(0);
      
      const getUser = classSymbol?.children?.find(c => c.name === 'getUser');
      expect(getUser).toBeDefined();
      expect(getUser?.symbol_kind).toBe(SymbolKind.METHOD);
      expect(getUser?.is_async).toBe(true);
    });

    it('should extract interfaces', () => {
      const code = `
interface UserConfig {
  name: string;
  age?: number;
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'types.ts', code);

      expect(result.success).toBe(true);
      const iface = result.symbols.find(s => s.name === 'UserConfig');
      expect(iface).toBeDefined();
      expect(iface?.symbol_kind).toBe(SymbolKind.INTERFACE);
    });

    it('should extract type aliases', () => {
      const code = `
type UserId = string | number;
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'types.ts', code);

      expect(result.success).toBe(true);
      const typeAlias = result.symbols.find(s => s.name === 'UserId');
      expect(typeAlias).toBeDefined();
      expect(typeAlias?.symbol_kind).toBe(SymbolKind.TYPE_ALIAS);
    });

    it('should extract enums', () => {
      const code = `
enum Status {
  ACTIVE,
  INACTIVE,
  PENDING
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'enums.ts', code);

      expect(result.success).toBe(true);
      const enumSymbol = result.symbols.find(s => s.name === 'Status');
      expect(enumSymbol).toBeDefined();
      expect(enumSymbol?.symbol_kind).toBe(SymbolKind.ENUM);
    });

    it('should extract arrow functions assigned to const', () => {
      const code = `
export const calculateTotal = (items: Item[]): number => {
  return items.reduce((sum, item) => sum + item.price, 0);
};
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'utils.ts', code);

      expect(result.success).toBe(true);
      const func = result.symbols.find(s => s.name === 'calculateTotal');
      expect(func).toBeDefined();
      expect(func?.symbol_kind).toBe(SymbolKind.FUNCTION);
      expect(func?.is_exported).toBe(true);
    });

    it('should extract JSDoc comments', () => {
      const code = `
/**
 * Calculates the sum of two numbers.
 * @param a - First number
 * @param b - Second number
 * @returns The sum
 */
function add(a: number, b: number): number {
  return a + b;
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'math.ts', code);

      expect(result.success).toBe(true);
      const func = result.symbols.find(s => s.name === 'add');
      expect(func?.docstring).toBeDefined();
      expect(func?.docstring?.doc_type).toBe('jsdoc');
      expect(func?.docstring?.description).toContain('Calculates the sum');
    });
  });

  describe('Usage Extraction', () => {
    it('should extract function calls', () => {
      const code = `
import { getData } from './data';

const result = getData();
console.log(result);
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'app.ts', code);

      expect(result.success).toBe(true);
      const calls = result.usages.filter(u => u.usage_type === 'call');
      expect(calls.some(u => u.symbol_name === 'getData')).toBe(true);
    });

    it('should extract type references', () => {
      const code = `
import { User } from './types';

const user: User = { name: 'test' };
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'app.ts', code);

      expect(result.success).toBe(true);
      const typeRefs = result.usages.filter(u => u.usage_type === 'type_ref');
      expect(typeRefs.some(u => u.symbol_name === 'User')).toBe(true);
    });

    it('should extract class instantiation', () => {
      const code = `
import { UserService } from './service';

const service = new UserService();
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'app.ts', code);

      expect(result.success).toBe(true);
      const instantiations = result.usages.filter(u => u.usage_type === 'instantiate');
      expect(instantiations.some(u => u.symbol_name === 'UserService')).toBe(true);
    });

    it('should not extract definition names as usages', () => {
      const code = `
function myFunction() {
  return 42;
}
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'test.ts', code);

      expect(result.success).toBe(true);
      // myFunction should not be in usages since it's a definition
      const myFuncUsages = result.usages.filter(u => u.symbol_name === 'myFunction');
      expect(myFuncUsages).toHaveLength(0);
    });
  });

  describe('Import Extraction', () => {
    it('should extract ES module imports', () => {
      const code = `
import React from 'react';
import { useState, useEffect } from 'react';
import * as lodash from 'lodash';
import type { FC } from 'react';
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'app.tsx', code);

      expect(result.success).toBe(true);
      expect(result.imports.length).toBeGreaterThanOrEqual(3);

      // Check default import
      const reactImport = result.imports.find(i => 
        i.module_specifier === 'react' && 
        i.bindings.some(b => b.imported_name === 'default')
      );
      expect(reactImport).toBeDefined();

      // Check named imports
      const namedImport = result.imports.find(i =>
        i.module_specifier === 'react' &&
        i.bindings.some(b => b.imported_name === 'useState')
      );
      expect(namedImport).toBeDefined();

      // Check namespace import
      const namespaceImport = result.imports.find(i =>
        i.module_specifier === 'lodash' &&
        i.bindings.some(b => b.imported_name === '*')
      );
      expect(namespaceImport).toBeDefined();
    });

    it('should extract CommonJS requires', () => {
      const code = `
const fs = require('fs');
const { join, resolve } = require('path');
`;
      const tree = parseCode(code, 'javascript');
      const result = extractor.extract(tree, 'utils.js', code);

      expect(result.success).toBe(true);
      
      const fsImport = result.imports.find(i => i.module_specifier === 'fs');
      expect(fsImport).toBeDefined();
      expect(fsImport?.import_type).toBe('commonjs');

      const pathImport = result.imports.find(i => i.module_specifier === 'path');
      expect(pathImport).toBeDefined();
      expect(pathImport?.bindings.some(b => b.imported_name === 'join')).toBe(true);
    });

    it('should handle type-only imports', () => {
      const code = `
import type { User, Config } from './types';
`;
      const tree = parseCode(code, 'typescript');
      const result = extractor.extract(tree, 'app.ts', code);

      expect(result.success).toBe(true);
      const typeImport = result.imports.find(i => i.module_specifier === './types');
      expect(typeImport).toBeDefined();
      expect(typeImport?.bindings.every(b => b.is_type_only)).toBe(true);
    });
  });
});
