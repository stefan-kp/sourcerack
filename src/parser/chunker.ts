/**
 * Code chunker for SourceRack
 *
 * Extracts semantic chunks (functions, classes, methods) from AST.
 */

import Parser from 'tree-sitter';
import {
  CodeChunk,
  ParseResult,
  SymbolType,
  SupportedLanguage,
} from './types.js';
import {
  initializeTreeSitter,
  parseCode,
  detectLanguage,
  isLanguageReady,
} from './tree-sitter.js';

/**
 * Node types that represent top-level code units for each language
 */
const CHUNK_NODE_TYPES: Record<SupportedLanguage, Record<string, SymbolType>> = {
  javascript: {
    function_declaration: 'function',
    function_expression: 'function',
    arrow_function: 'function',
    class_declaration: 'class',
    method_definition: 'method',
    export_statement: 'module',
  },
  typescript: {
    function_declaration: 'function',
    function_expression: 'function',
    arrow_function: 'function',
    class_declaration: 'class',
    method_definition: 'method',
    export_statement: 'module',
    interface_declaration: 'class',
    type_alias_declaration: 'other',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_declaration: 'class',
  },
  rust: {
    function_item: 'function',
    impl_item: 'class',
    struct_item: 'class',
    enum_item: 'class',
    trait_item: 'class',
  },
  java: {
    method_declaration: 'method',
    constructor_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'class',
  },
  c: {
    function_definition: 'function',
    struct_specifier: 'class',
  },
  cpp: {
    function_definition: 'function',
    class_specifier: 'class',
    struct_specifier: 'class',
  },
};

/**
 * Extract symbol name from AST node
 */
function extractSymbolName(node: Parser.SyntaxNode, _language: SupportedLanguage): string {
  // Look for name/identifier child nodes
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('declarator') ??
    node.children.find((c) => c.type === 'identifier' || c.type === 'property_identifier');

  if (nameNode !== null && nameNode !== undefined) {
    // For declarators in C/C++, extract the actual name
    if (nameNode.type === 'function_declarator') {
      const innerName = nameNode.childForFieldName('declarator');
      if (innerName !== null && innerName !== undefined) {
        return innerName.text;
      }
    }
    return nameNode.text;
  }

  // For anonymous functions, use location as name
  return `anonymous_${node.startPosition.row + 1}`;
}

/**
 * Check if a node type is a chunk-worthy symbol
 */
function isChunkNode(
  nodeType: string,
  language: SupportedLanguage
): SymbolType | null {
  const types = CHUNK_NODE_TYPES[language];
  if (types === undefined) return null;
  return types[nodeType] ?? null;
}

/**
 * Extract chunks from AST recursively
 */
function extractChunksFromNode(
  node: Parser.SyntaxNode,
  language: SupportedLanguage,
  sourceCode: string,
  filePath: string,
  parentClass?: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const symbolType = isChunkNode(node.type, language);

  if (symbolType !== null) {
    let symbolName = extractSymbolName(node, language);

    // Prefix method names with class name
    if (symbolType === 'method' && parentClass !== undefined) {
      symbolName = `${parentClass}.${symbolName}`;
    }

    chunks.push({
      path: filePath,
      symbol: symbolName,
      symbolType,
      language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      content: node.text,
    });

    // For classes, extract methods as children
    if (symbolType === 'class') {
      const className = extractSymbolName(node, language);
      for (const child of node.children) {
        chunks.push(
          ...extractChunksFromNode(
            child,
            language,
            sourceCode,
            filePath,
            className
          )
        );
      }
    }
  } else {
    // Continue traversing for non-chunk nodes
    for (const child of node.children) {
      chunks.push(
        ...extractChunksFromNode(child, language, sourceCode, filePath, parentClass)
      );
    }
  }

  return chunks;
}

/**
 * Parse a file and extract code chunks
 *
 * @param filePath - Relative file path
 * @param content - File content
 * @param language - Optional language override
 * @returns Parse result with chunks
 */
export async function parseFile(
  filePath: string,
  content: string,
  language?: SupportedLanguage
): Promise<ParseResult> {
  // Ensure tree-sitter is initialized
  await initializeTreeSitter();

  // Detect language if not provided
  const detectedLanguage = language ?? detectLanguage(filePath);

  if (detectedLanguage === null) {
    // Return fallback text chunk for unsupported files
    return createFallbackResult(filePath, content, 'unknown');
  }

  if (!isLanguageReady(detectedLanguage)) {
    // Language supported but grammar not loaded
    return createFallbackResult(filePath, content, detectedLanguage);
  }

  try {
    const tree = parseCode(content, detectedLanguage);
    const chunks = extractChunksFromNode(
      tree.rootNode,
      detectedLanguage,
      content,
      filePath
    );

    // If no chunks extracted, create a module-level chunk
    if (chunks.length === 0) {
      chunks.push({
        path: filePath,
        symbol: 'module',
        symbolType: 'module',
        language: detectedLanguage,
        startLine: 1,
        endLine: content.split('\n').length,
        content,
      });
    }

    return {
      path: filePath,
      language: detectedLanguage,
      chunks,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: filePath,
      language: detectedLanguage,
      chunks: [],
      success: false,
      error: `Parse failed: ${message}`,
    };
  }
}

/**
 * Create fallback result for unsupported or unparseable files
 */
function createFallbackResult(
  filePath: string,
  content: string,
  language: string
): ParseResult {
  // Split into text chunks based on line count
  const lines = content.split('\n');
  const chunkSize = 50; // lines per chunk
  const chunks: CodeChunk[] = [];

  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunkLines = lines.slice(i, Math.min(i + chunkSize, lines.length));
    const startLine = i + 1;
    const endLine = Math.min(i + chunkSize, lines.length);

    chunks.push({
      path: filePath,
      symbol: `text_chunk_${Math.floor(i / chunkSize) + 1}`,
      symbolType: 'other',
      language,
      startLine,
      endLine,
      content: chunkLines.join('\n'),
    });
  }

  return {
    path: filePath,
    language,
    chunks,
    success: true,
  };
}

/**
 * Batch parse multiple files
 */
export async function parseFiles(
  files: { path: string; content: string }[]
): Promise<ParseResult[]> {
  await initializeTreeSitter();

  return Promise.all(
    files.map((file) => parseFile(file.path, file.content))
  );
}
