/**
 * YAML-based SQI test runner
 * 
 * Loads test cases from YAML files and validates symbol extraction.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { initializeTreeSitter, parseCodeWithAutoLoad } from '../../../src/parser/tree-sitter.js';
import { TypeScriptExtractor } from '../../../src/sqi/extractors/typescript.js';
import { PythonExtractor } from '../../../src/sqi/extractors/python.js';
import { RubyExtractor } from '../../../src/sqi/extractors/ruby.js';
import { DartExtractor } from '../../../src/sqi/extractors/dart.js';
import type { SymbolExtractor, ExtractedSymbol } from '../../../src/sqi/types.js';

// Test case interfaces
interface ParameterExpectation {
  name: string;
  type?: string;
}

interface SymbolExpectation {
  name: string;
  kind?: string;
  is_exported?: boolean;
  is_async?: boolean;
  is_abstract?: boolean;
  return_type?: string;
  parameters?: ParameterExpectation[];
  children?: SymbolExpectation[];
}

interface TestCaseExpectation {
  symbols?: SymbolExpectation[];
  usages?: { symbol: string; kind: string }[];
}

interface TestCase {
  name: string;
  code: string;
  expect: TestCaseExpectation;
  skip?: boolean;
}

interface TestSuite {
  name: string;
  language: string;
  description?: string;
  skip?: boolean;
  cases: TestCase[];
}

// Map of language to extractor
const extractors: Record<string, SymbolExtractor> = {
  typescript: new TypeScriptExtractor(),
  tsx: new TypeScriptExtractor(),
  python: new PythonExtractor(),
  ruby: new RubyExtractor(),
  dart: new DartExtractor(),
};

// Map of language to tree-sitter language ID
const languageIds: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  ruby: 'ruby',
  dart: 'dart',
};

/**
 * Normalize symbol kind for comparison
 */
function normalizeKind(kind: string): string {
  return kind.toLowerCase().replace(/_/g, '');
}

/**
 * Check if actual symbol matches expectation
 */
function matchesSymbol(actual: ExtractedSymbol, expected: SymbolExpectation): boolean {
  // Name must match
  if (actual.name !== expected.name) {
    return false;
  }

  // Kind must match if specified
  if (expected.kind !== undefined) {
    const actualKind = normalizeKind(actual.symbol_kind);
    const expectedKind = normalizeKind(expected.kind);
    if (actualKind !== expectedKind) {
      return false;
    }
  }

  return true;
}

/**
 * Find matching symbol in list
 */
function findMatchingSymbol(
  symbols: ExtractedSymbol[],
  expected: SymbolExpectation
): ExtractedSymbol | undefined {
  return symbols.find(s => matchesSymbol(s, expected));
}

/**
 * Validate symbol properties
 */
function validateSymbol(
  actual: ExtractedSymbol,
  expected: SymbolExpectation,
  path: string = ''
): string[] {
  const errors: string[] = [];
  const symbolPath = path ? `${path}.${actual.name}` : actual.name;

  // Check is_exported
  if (expected.is_exported !== undefined && actual.is_exported !== expected.is_exported) {
    errors.push(`${symbolPath}: expected is_exported=${expected.is_exported}, got ${actual.is_exported}`);
  }

  // Check is_async
  if (expected.is_async !== undefined && actual.is_async !== expected.is_async) {
    errors.push(`${symbolPath}: expected is_async=${expected.is_async}, got ${actual.is_async}`);
  }

  // Check is_abstract
  if (expected.is_abstract !== undefined && actual.is_abstract !== expected.is_abstract) {
    errors.push(`${symbolPath}: expected is_abstract=${expected.is_abstract}, got ${actual.is_abstract}`);
  }

  // Check return_type
  if (expected.return_type !== undefined && actual.return_type !== expected.return_type) {
    errors.push(`${symbolPath}: expected return_type=${expected.return_type}, got ${actual.return_type}`);
  }

  // Check parameters
  if (expected.parameters !== undefined) {
    const actualParams = actual.parameters ?? [];
    for (const expectedParam of expected.parameters) {
      const actualParam = actualParams.find(p => p.name === expectedParam.name);
      if (!actualParam) {
        errors.push(`${symbolPath}: missing parameter '${expectedParam.name}'`);
      } else if (expectedParam.type !== undefined && actualParam.type !== expectedParam.type) {
        errors.push(
          `${symbolPath}: parameter '${expectedParam.name}' expected type=${expectedParam.type}, got ${actualParam.type}`
        );
      }
    }
  }

  // Check children recursively
  if (expected.children !== undefined) {
    const actualChildren = actual.children ?? [];
    for (const expectedChild of expected.children) {
      const actualChild = findMatchingSymbol(actualChildren, expectedChild);
      if (!actualChild) {
        errors.push(`${symbolPath}: missing child symbol '${expectedChild.name}' (${expectedChild.kind ?? 'any'})`);
      } else {
        errors.push(...validateSymbol(actualChild, expectedChild, symbolPath));
      }
    }
  }

  return errors;
}

/**
 * Load and parse YAML test file
 */
function loadTestSuite(filePath: string): TestSuite {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.parse(content) as TestSuite;
}

/**
 * Get all YAML test files
 */
function getTestFiles(): string[] {
  const fixturesDir = path.join(__dirname, '../../fixtures/sqi');
  if (!fs.existsSync(fixturesDir)) {
    return [];
  }
  return fs.readdirSync(fixturesDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.join(fixturesDir, f));
}

// Run tests
describe('YAML-based SQI Tests', () => {
  beforeAll(async () => {
    await initializeTreeSitter();
  });

  const testFiles = getTestFiles();
  
  if (testFiles.length === 0) {
    it.skip('no YAML test files found', () => {});
    return;
  }

  for (const testFile of testFiles) {
    const suite = loadTestSuite(testFile);
    const extractor = extractors[suite.language];
    const languageId = languageIds[suite.language];

    // Skip entire suite if marked
    if (suite.skip) {
      describe.skip(suite.name, () => {
        it(`suite skipped: ${suite.description ?? 'no description'}`, () => {});
      });
      continue;
    }

    if (!extractor) {
      describe(suite.name, () => {
        it.skip(`no extractor for language: ${suite.language}`, () => {});
      });
      continue;
    }

    describe(suite.name, () => {
      for (const testCase of suite.cases) {
        const testFn = testCase.skip ? it.skip : it;
        
        testFn(testCase.name, async () => {
          // Parse code
          const tree = await parseCodeWithAutoLoad(testCase.code, languageId);
          
          // Extract symbols
          const result = extractor.extract(tree, `test.${suite.language}`, testCase.code);
          
          // Validate extraction succeeded
          expect(result.success).toBe(true);
          
          // Validate expected symbols
          if (testCase.expect.symbols) {
            const errors: string[] = [];
            
            for (const expectedSymbol of testCase.expect.symbols) {
              const actualSymbol = findMatchingSymbol(result.symbols, expectedSymbol);
              
              if (!actualSymbol) {
                errors.push(`Missing symbol '${expectedSymbol.name}' (${expectedSymbol.kind ?? 'any'})`);
                continue;
              }
              
              errors.push(...validateSymbol(actualSymbol, expectedSymbol));
            }
            
            if (errors.length > 0) {
              // Also log actual symbols for debugging
              console.log('Actual symbols:', JSON.stringify(result.symbols.map(s => ({
                name: s.name,
                kind: s.symbol_kind,
                children: s.children?.map(c => ({ name: c.name, kind: c.symbol_kind }))
              })), null, 2));
              
              throw new Error(`Symbol validation failed:\n${errors.join('\n')}`);
            }
          }
          
          // Validate usages if specified
          if (testCase.expect.usages) {
            for (const expectedUsage of testCase.expect.usages) {
              const found = result.usages?.some(
                u => u.name === expectedUsage.symbol
              );
              expect(found).toBe(true);
            }
          }
        });
      }
    });
  }
});
