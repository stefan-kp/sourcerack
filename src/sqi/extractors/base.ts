/**
 * Base Symbol Extractor for SQI
 *
 * Abstract base class defining the interface for language-specific
 * symbol extraction from Tree-sitter ASTs.
 */

import Parser from 'tree-sitter';
import { createHash } from 'node:crypto';
import {
  SymbolKind,
  Visibility,
  ExtractedSymbol,
  ExtractedUsage,
  ExtractedImport,
  FileExtractionResult,
} from '../types.js';

/**
 * Abstract base class for language-specific symbol extractors
 */
export abstract class SymbolExtractor {
  /**
   * The language this extractor handles
   */
  abstract readonly language: string;

  /**
   * Additional language aliases (e.g., 'tsx' for 'typescript')
   */
  readonly aliases: string[] = [];

  /**
   * Extract all symbols, usages, and imports from a parsed file
   *
   * @param tree - Parsed Tree-sitter tree
   * @param filePath - Relative file path
   * @param sourceCode - Original source code
   * @returns Extraction result with symbols, usages, and imports
   */
  extract(
    tree: Parser.Tree,
    filePath: string,
    sourceCode: string
  ): FileExtractionResult {
    try {
      const symbols = this.extractSymbols(tree.rootNode, filePath, sourceCode);
      const usages = this.extractUsages(tree.rootNode, filePath, sourceCode);
      const imports = this.extractImports(tree.rootNode, filePath, sourceCode);

      return {
        file_path: filePath,
        language: this.language,
        symbols,
        usages,
        imports,
        success: true,
      };
    } catch (error) {
      return {
        file_path: filePath,
        language: this.language,
        symbols: [],
        usages: [],
        imports: [],
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Extract symbols from AST (to be implemented by subclasses)
   */
  protected abstract extractSymbols(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedSymbol[];

  /**
   * Extract usages/references from AST (to be implemented by subclasses)
   */
  protected abstract extractUsages(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedUsage[];

  /**
   * Extract imports from AST (to be implemented by subclasses)
   */
  protected abstract extractImports(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedImport[];

  // ==================== Helper Methods ====================

  /**
   * Generate content hash for deduplication
   */
  protected generateContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Get text content of a node
   */
  protected getNodeText(node: Parser.SyntaxNode): string {
    return node.text;
  }

  /**
   * Find child node by field name
   */
  protected getChildByField(
    node: Parser.SyntaxNode,
    fieldName: string
  ): Parser.SyntaxNode | null {
    return node.childForFieldName(fieldName);
  }

  /**
   * Find all children of a specific type
   */
  protected getChildrenByType(
    node: Parser.SyntaxNode,
    type: string
  ): Parser.SyntaxNode[] {
    return node.children.filter((child) => child.type === type);
  }

  /**
   * Find first child of a specific type
   */
  protected getFirstChildByType(
    node: Parser.SyntaxNode,
    type: string
  ): Parser.SyntaxNode | null {
    return node.children.find((child) => child.type === type) ?? null;
  }

  /**
   * Find descendant by type (depth-first)
   */
  protected findDescendantByType(
    node: Parser.SyntaxNode,
    type: string
  ): Parser.SyntaxNode | null {
    if (node.type === type) return node;

    for (const child of node.children) {
      const found = this.findDescendantByType(child, type);
      if (found) return found;
    }

    return null;
  }

  /**
   * Find all descendants of a specific type
   */
  protected findAllDescendantsByType(
    node: Parser.SyntaxNode,
    type: string
  ): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];

    if (node.type === type) {
      results.push(node);
    }

    for (const child of node.children) {
      results.push(...this.findAllDescendantsByType(child, type));
    }

    return results;
  }

  /**
   * Find all descendants matching multiple types
   */
  protected findAllDescendantsByTypes(
    node: Parser.SyntaxNode,
    types: string[]
  ): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];

    if (types.includes(node.type)) {
      results.push(node);
    }

    for (const child of node.children) {
      results.push(...this.findAllDescendantsByTypes(child, types));
    }

    return results;
  }

  /**
   * Get identifier name from various node types
   */
  protected extractIdentifierName(node: Parser.SyntaxNode): string | null {
    // Direct identifier
    if (node.type === 'identifier' || node.type === 'property_identifier') {
      return node.text;
    }

    // Check for name field
    const nameNode = this.getChildByField(node, 'name');
    if (nameNode) {
      return nameNode.text;
    }

    // Check for identifier child
    const idChild = this.getFirstChildByType(node, 'identifier');
    if (idChild) {
      return idChild.text;
    }

    return null;
  }

  /**
   * Build qualified name from parent chain
   */
  protected buildQualifiedName(
    name: string,
    parentQualifiedName?: string
  ): string {
    if (parentQualifiedName) {
      return `${parentQualifiedName}.${name}`;
    }
    return name;
  }

  /**
   * Get line and column from node
   */
  protected getLocation(node: Parser.SyntaxNode): {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  } {
    return {
      startLine: node.startPosition.row + 1, // 1-based
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
    };
  }

  /**
   * Check if node is inside another node type
   */
  protected isInsideNodeType(
    node: Parser.SyntaxNode,
    type: string
  ): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === type) return true;
      current = current.parent;
    }
    return false;
  }

  /**
   * Find enclosing function/method/class
   */
  protected findEnclosingSymbol(
    node: Parser.SyntaxNode,
    symbolTypes: string[]
  ): Parser.SyntaxNode | null {
    let current = node.parent;
    while (current) {
      if (symbolTypes.includes(current.type)) return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * Extract preceding comment/docstring
   */
  protected extractPrecedingComment(
    node: Parser.SyntaxNode,
    _sourceCode: string
  ): string | null {
    // Get previous sibling
    const prevSibling = node.previousNamedSibling;
    if (!prevSibling) return null;

    // Check if it's a comment
    if (prevSibling.type === 'comment' || prevSibling.type.includes('comment')) {
      return prevSibling.text;
    }

    return null;
  }

  /**
   * Traverse AST and call visitor for each node
   */
  protected traverse(
    node: Parser.SyntaxNode,
    visitor: (node: Parser.SyntaxNode) => void
  ): void {
    visitor(node);
    for (const child of node.children) {
      this.traverse(child, visitor);
    }
  }

  /**
   * Traverse AST with ability to skip subtrees
   */
  protected traverseWithControl(
    node: Parser.SyntaxNode,
    visitor: (node: Parser.SyntaxNode) => boolean // return false to skip children
  ): void {
    const shouldContinue = visitor(node);
    if (shouldContinue) {
      for (const child of node.children) {
        this.traverseWithControl(child, visitor);
      }
    }
  }
}

/**
 * Helper type for node type to symbol kind mapping
 */
export type NodeTypeMapping = Record<string, SymbolKind>;

/**
 * Helper type for visibility extraction
 */
export type VisibilityMapping = Record<string, Visibility>;
