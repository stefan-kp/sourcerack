/**
 * Fastify Endpoint Extractor
 *
 * Extracts API endpoints from Fastify applications.
 *
 * Supports:
 * - fastify.get('/path', handler)
 * - fastify.get('/path', { schema: {...} }, handler)
 * - fastify.route({ method: 'GET', url: '/path', handler })
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  ExtractedEndpoint,
} from './types.js';

/**
 * HTTP methods used in Fastify
 */
const FASTIFY_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

/**
 * Fastify endpoint extractor for TypeScript/JavaScript
 */
export class FastifyExtractor extends EndpointExtractor {
  readonly framework: Framework = 'fastify';
  readonly language = 'typescript';
  readonly aliases = ['javascript', 'tsx', 'jsx'];

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) => imp === 'fastify');
  }

  /**
   * Extract endpoints from Fastify code
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
      // Try method shorthand (fastify.get, fastify.post, etc.)
      const methodEndpoint = this.extractFromMethodShorthand(call, filePath);
      if (methodEndpoint) {
        endpoints.push(methodEndpoint);
        continue;
      }

      // Try fastify.route({ ... })
      const routeEndpoint = this.extractFromRouteMethod(call, filePath);
      if (routeEndpoint) {
        endpoints.push(routeEndpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract endpoint from fastify.get('/path', handler) pattern
   */
  private extractFromMethodShorthand(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    const funcNode = this.getChildByField(callNode, 'function');
    if (funcNode?.type !== 'member_expression') return null;

    const propertyNode = this.getChildByField(funcNode, 'property');
    if (!propertyNode) return null;

    const methodName = propertyNode.text.toLowerCase();
    if (!FASTIFY_HTTP_METHODS.includes(methodName)) return null;

    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    const args = argsNode.children.filter(c =>
      c.type !== '(' && c.type !== ')' && c.type !== ','
    );

    if (args.length === 0) return null;

    // First arg is path
    const pathArg = args[0];
    if (!pathArg) return null;

    const path = this.extractStringValue(pathArg);
    if (!path) return null;

    // Check for schema in second arg (if it's an object)
    let schemaText: string | undefined;
    if (args.length >= 2 && args[1]?.type === 'object') {
      schemaText = args[1].text;
    }

    const location = this.getLocation(callNode);

    const options: CreateEndpointOptions = {
      http_method: this.normalizeHttpMethod(methodName),
      path,
      path_params: this.parsePathParams(path),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'fastify',
      handler_type: 'inline',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (schemaText) options.body_schema = schemaText;

    return this.createEndpoint(options);
  }

  /**
   * Extract endpoint from fastify.route({ method, url, handler }) pattern
   */
  private extractFromRouteMethod(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    const funcNode = this.getChildByField(callNode, 'function');
    if (funcNode?.type !== 'member_expression') return null;

    const propertyNode = this.getChildByField(funcNode, 'property');
    if (propertyNode?.text !== 'route') return null;

    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    // Find the options object
    const optionsArg = argsNode.children.find(c => c.type === 'object');
    if (!optionsArg) return null;

    // Extract method, url, and schema from the object
    let method: string | undefined;
    let url: string | undefined;
    let schemaText: string | undefined;

    const pairs = this.getChildrenByType(optionsArg, 'pair');
    for (const pair of pairs) {
      const keyNode = this.getChildByField(pair, 'key');
      const valueNode = this.getChildByField(pair, 'value');
      if (!keyNode || !valueNode) continue;

      const key = this.extractPropertyKey(keyNode);

      switch (key) {
        case 'method': {
          const val = this.extractStringValue(valueNode);
          if (val) method = val;
          break;
        }
        case 'url':
        case 'path': {
          const val = this.extractStringValue(valueNode);
          if (val) url = val;
          break;
        }
        case 'schema':
          schemaText = valueNode.text;
          break;
      }
    }

    if (!method || !url) return null;

    const location = this.getLocation(callNode);

    const options: CreateEndpointOptions = {
      http_method: this.normalizeHttpMethod(method),
      path: url,
      path_params: this.parsePathParams(url),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'fastify',
      handler_type: 'inline',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (schemaText) options.body_schema = schemaText;

    return this.createEndpoint(options);
  }

  /**
   * Extract property key from a key node
   */
  private extractPropertyKey(node: Parser.SyntaxNode): string | null {
    if (node.type === 'property_identifier' || node.type === 'identifier') {
      return node.text;
    }
    if (node.type === 'string') {
      return this.extractStringValue(node);
    }
    return null;
  }
}
