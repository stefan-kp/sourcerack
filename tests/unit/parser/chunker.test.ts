import { describe, it, expect, beforeAll } from 'vitest';
import { parseFile } from '../../../src/parser/chunker.js';
import { initializeTreeSitter } from '../../../src/parser/tree-sitter.js';

describe('Chunker', () => {
  beforeAll(async () => {
    await initializeTreeSitter();
  });

  describe('parseFile', () => {
    it('should parse JavaScript functions', async () => {
      const code = `
function hello() {
  console.log("Hello");
}

function world() {
  console.log("World");
}
`;
      const result = await parseFile('test.js', code);

      expect(result.success).toBe(true);
      expect(result.language).toBe('javascript');
      expect(result.chunks.length).toBeGreaterThanOrEqual(2);

      const helloChunk = result.chunks.find((c) => c.symbol === 'hello');
      expect(helloChunk).toBeDefined();
      expect(helloChunk?.symbolType).toBe('function');
    });

    it('should parse TypeScript classes', async () => {
      const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
`;
      const result = await parseFile('calculator.ts', code);

      expect(result.success).toBe(true);
      expect(result.language).toBe('typescript');

      // Should have class and potentially methods
      const classChunk = result.chunks.find(
        (c) => c.symbol === 'Calculator' && c.symbolType === 'class'
      );
      expect(classChunk).toBeDefined();
    });

    it('should parse Python functions', async () => {
      const code = `
def greet(name):
    print(f"Hello, {name}")

def farewell(name):
    print(f"Goodbye, {name}")
`;
      const result = await parseFile('test.py', code);

      expect(result.success).toBe(true);
      expect(result.language).toBe('python');

      const greetChunk = result.chunks.find((c) => c.symbol === 'greet');
      expect(greetChunk).toBeDefined();
      expect(greetChunk?.symbolType).toBe('function');
    });

    it('should handle unsupported file types with fallback', async () => {
      const code = 'Some plain text content\nLine 2\nLine 3';
      const result = await parseFile('readme.txt', code);

      expect(result.success).toBe(true);
      expect(result.language).toBe('unknown');
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should include line numbers in chunks', async () => {
      const code = `
// Comment
function test() {
  return 42;
}
`;
      const result = await parseFile('test.js', code);

      expect(result.success).toBe(true);
      const testChunk = result.chunks.find((c) => c.symbol === 'test');
      expect(testChunk).toBeDefined();
      expect(testChunk?.startLine).toBeGreaterThan(0);
      expect(testChunk?.endLine).toBeGreaterThanOrEqual(testChunk?.startLine ?? 0);
    });

    it('should detect language from file extension', async () => {
      const result = await parseFile('app.ts', 'const x = 1;');
      expect(result.language).toBe('typescript');

      const result2 = await parseFile('main.py', 'x = 1');
      expect(result2.language).toBe('python');

      const result3 = await parseFile('main.go', 'package main');
      expect(result3.language).toBe('go');
    });
  });
});
