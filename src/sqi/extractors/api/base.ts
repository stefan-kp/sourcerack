/**
 * Base Endpoint Extractor for API Discovery
 *
 * Abstract base class defining the interface for framework-specific
 * API endpoint extraction from Tree-sitter ASTs.
 */

import Parser from 'tree-sitter';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
  EndpointExtractionResult,
  EndpointParam,
  ParamLocation,
} from './types.js';

/**
 * Abstract base class for framework-specific endpoint extractors
 */
export abstract class EndpointExtractor {
  /**
   * The framework this extractor handles
   */
  abstract readonly framework: Framework;

  /**
   * The programming language this extractor works with
   */
  abstract readonly language: string;

  /**
   * Additional framework aliases (e.g., 'koa' might use express patterns)
   */
  readonly aliases: string[] = [];

  /**
   * Extract all API endpoints from a parsed file
   *
   * @param tree - Parsed Tree-sitter tree
   * @param filePath - Relative file path
   * @param sourceCode - Original source code
   * @returns Extraction result with endpoints
   */
  extract(
    tree: Parser.Tree,
    filePath: string,
    sourceCode: string
  ): EndpointExtractionResult {
    try {
      const endpoints = this.extractEndpoints(tree.rootNode, filePath, sourceCode);

      return {
        file_path: filePath,
        framework: this.framework,
        endpoints,
        success: true,
      };
    } catch (error) {
      return {
        file_path: filePath,
        framework: this.framework,
        endpoints: [],
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if this extractor can handle the given file
   * Override in subclasses for more specific detection
   *
   * @param filePath - File path
   * @param imports - Detected imports in the file
   */
  abstract canHandle(filePath: string, imports: string[]): boolean;

  /**
   * Extract endpoints from AST (to be implemented by subclasses)
   */
  protected abstract extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedEndpoint[];

  // ==================== Helper Methods ====================

  /**
   * Parse path parameters from a route path
   * Handles different frameworks' path param syntax
   *
   * @example
   * parsePathParams('/users/:id')      → ['id']
   * parsePathParams('/users/{user_id}') → ['user_id']
   * parsePathParams('/api/v1/*')        → []
   */
  protected parsePathParams(path: string): string[] {
    const params: string[] = [];

    // Express/Koa style: :param
    const colonMatches = path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (colonMatches) {
      for (const match of colonMatches) {
        params.push(match.slice(1)); // Remove ':'
      }
    }

    // FastAPI/OpenAPI style: {param}
    const braceMatches = path.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
    if (braceMatches) {
      for (const match of braceMatches) {
        params.push(match.slice(1, -1)); // Remove '{' and '}'
      }
    }

    // Rails style: :param (same as Express)
    // Already handled above

    return params;
  }

  /**
   * Normalize HTTP method to uppercase
   */
  protected normalizeHttpMethod(method: string): HttpMethod {
    const upper = method.toUpperCase();
    const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL'];
    return validMethods.includes(upper as HttpMethod) ? (upper as HttpMethod) : 'ALL';
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
    visitor: (node: Parser.SyntaxNode) => boolean
  ): void {
    const shouldContinue = visitor(node);
    if (shouldContinue) {
      for (const child of node.children) {
        this.traverseWithControl(child, visitor);
      }
    }
  }

  /**
   * Extract string value from a string literal node
   * Handles different quote styles
   */
  protected extractStringValue(node: Parser.SyntaxNode): string | null {
    const text = node.text;

    // Remove quotes
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('`') && text.endsWith('`'))
    ) {
      return text.slice(1, -1);
    }

    // Python triple quotes
    if (text.startsWith('"""') && text.endsWith('"""')) {
      return text.slice(3, -3);
    }
    if (text.startsWith("'''") && text.endsWith("'''")) {
      return text.slice(3, -3);
    }

    return text;
  }

  /**
   * Check if node is inside another node type
   */
  protected isInsideNodeType(node: Parser.SyntaxNode, type: string): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === type) return true;
      current = current.parent;
    }
    return false;
  }

  /**
   * Create a minimal endpoint with defaults
   */
  protected createEndpoint(
    partial: {
      http_method: HttpMethod;
      path: string;
      file_path: string;
      start_line: number;
      end_line: number;
      path_params?: string[];
      framework?: Framework;
      handler_name?: string;
      handler_type?: ExtractedEndpoint['handler_type'];
      middleware?: string[];
      dependencies?: string[];
      summary?: string;
      description?: string;
      tags?: string[];
      query_params?: EndpointParam[];
      body_schema?: string;
      body_content_type?: string;
      response_model?: string;
      response_status?: number;
      response_description?: string;
      mcp_tool_name?: string;
      mcp_input_schema?: string;
    }
  ): ExtractedEndpoint {
    const endpoint: ExtractedEndpoint = {
      http_method: partial.http_method,
      path: partial.path,
      path_params: partial.path_params ?? this.parsePathParams(partial.path),
      file_path: partial.file_path,
      start_line: partial.start_line,
      end_line: partial.end_line,
      framework: partial.framework ?? this.framework,
      handler_type: partial.handler_type ?? 'inline',
      middleware: partial.middleware ?? [],
      dependencies: partial.dependencies ?? [],
      tags: partial.tags ?? [],
      query_params: partial.query_params ?? [],
    };

    // Only set optional properties if they have values
    if (partial.handler_name !== undefined) endpoint.handler_name = partial.handler_name;
    if (partial.summary !== undefined) endpoint.summary = partial.summary;
    if (partial.description !== undefined) endpoint.description = partial.description;
    if (partial.body_schema !== undefined) endpoint.body_schema = partial.body_schema;
    if (partial.body_content_type !== undefined) endpoint.body_content_type = partial.body_content_type;
    if (partial.response_model !== undefined) endpoint.response_model = partial.response_model;
    if (partial.response_status !== undefined) endpoint.response_status = partial.response_status;
    if (partial.response_description !== undefined) endpoint.response_description = partial.response_description;
    if (partial.mcp_tool_name !== undefined) endpoint.mcp_tool_name = partial.mcp_tool_name;
    if (partial.mcp_input_schema !== undefined) endpoint.mcp_input_schema = partial.mcp_input_schema;

    return endpoint;
  }

  /**
   * Create an endpoint parameter
   */
  protected createParam(
    partial: {
      name: string;
      location: ParamLocation;
      type?: string;
      required?: boolean;
      default_value?: string;
      description?: string;
    }
  ): EndpointParam {
    const param: EndpointParam = {
      name: partial.name,
      location: partial.location,
      required: partial.required ?? true,
    };

    // Only set optional properties if they have values
    if (partial.type !== undefined) param.type = partial.type;
    if (partial.default_value !== undefined) param.default_value = partial.default_value;
    if (partial.description !== undefined) param.description = partial.description;

    return param;
  }
}
