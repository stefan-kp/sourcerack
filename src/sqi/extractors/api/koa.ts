/**
 * Koa Endpoint Extractor
 *
 * Extracts API endpoints from Koa applications using @koa/router.
 *
 * Supports:
 * - router.get('/path', handler)
 * - router.post('/path', middleware, handler)
 * - router.all('/path', handler)
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  ExtractedEndpoint,
} from './types.js';

/**
 * HTTP methods used in Koa router
 */
const KOA_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

/**
 * Koa endpoint extractor for TypeScript/JavaScript
 */
export class KoaExtractor extends EndpointExtractor {
  readonly framework: Framework = 'koa';
  readonly language = 'typescript';
  readonly aliases = ['javascript', 'tsx', 'jsx'];

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) =>
      imp === 'koa' ||
      imp === '@koa/router' ||
      imp === 'koa-router'
    );
  }

  /**
   * Extract endpoints from Koa code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find all call expressions
    const callExpressions = this.findAllDescendantsByType(rootNode, 'call_expression');

    for (const call of callExpressions) {
      const endpoint = this.extractEndpointFromCall(call, filePath);
      if (endpoint) {
        endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract endpoint from a call expression like router.get('/path', handler)
   */
  private extractEndpointFromCall(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    const funcNode = this.getChildByField(callNode, 'function');
    if (funcNode?.type !== 'member_expression') return null;

    const propertyNode = this.getChildByField(funcNode, 'property');
    if (!propertyNode) return null;

    const methodName = propertyNode.text.toLowerCase();
    if (!KOA_HTTP_METHODS.includes(methodName)) return null;

    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    const args = argsNode.children.filter(c =>
      c.type !== '(' && c.type !== ')' && c.type !== ','
    );

    if (args.length === 0) return null;

    // First arg is path
    const pathArg = args[0];
    if (!pathArg) return null;

    // Handle both string and identifier (for path constants)
    let path: string | null = null;
    if (pathArg.type === 'string') {
      path = this.extractStringValue(pathArg);
    }

    if (!path) return null;

    // Extract middleware
    const middleware: string[] = [];
    for (let i = 1; i < args.length - 1; i++) {
      const arg = args[i];
      if (arg?.type === 'identifier') {
        middleware.push(arg.text);
      } else if (arg?.type === 'call_expression') {
        const func = this.getChildByField(arg, 'function');
        if (func) {
          middleware.push(func.text);
        }
      }
    }

    const location = this.getLocation(callNode);

    const options: CreateEndpointOptions = {
      http_method: this.normalizeHttpMethod(methodName),
      path,
      path_params: this.parsePathParams(path),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'koa',
      handler_type: 'inline',
      middleware,
      dependencies: [],
      tags: [],
      query_params: [],
    };

    return this.createEndpoint(options);
  }
}
