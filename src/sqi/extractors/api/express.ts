/**
 * Express Endpoint Extractor
 *
 * Extracts API endpoints from Express.js applications.
 *
 * Supports:
 * - app.get('/path', handler)
 * - app.post('/path', middleware, handler)
 * - router.get('/path', handler)
 * - app.use('/prefix', router)
 * - app.route('/path').get(handler).post(handler)
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  ExtractedEndpoint,
} from './types.js';

/**
 * HTTP methods used in Express
 */
const EXPRESS_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

/**
 * Express endpoint extractor for TypeScript/JavaScript
 */
export class ExpressExtractor extends EndpointExtractor {
  readonly framework: Framework = 'express';
  readonly language = 'typescript';
  readonly aliases = ['javascript', 'tsx', 'jsx'];

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) => imp === 'express');
  }

  /**
   * Extract endpoints from Express code
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
   * Extract endpoint from a call expression like app.get('/path', handler)
   */
  private extractEndpointFromCall(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    const funcNode = this.getChildByField(callNode, 'function');
    if (!funcNode) return null;

    // Check for member expression (app.get, router.post, etc.)
    if (funcNode.type !== 'member_expression') return null;

    const propertyNode = this.getChildByField(funcNode, 'property');
    if (!propertyNode) return null;

    const methodName = propertyNode.text.toLowerCase();

    // Check if it's an HTTP method
    if (!EXPRESS_HTTP_METHODS.includes(methodName)) return null;

    // Get the arguments
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    // Filter out punctuation
    const args = argsNode.children.filter(c =>
      c.type !== '(' && c.type !== ')' && c.type !== ','
    );

    if (args.length === 0) return null;

    // First argument should be the path
    const pathArg = args[0];
    if (!pathArg) return null;

    const path = this.extractPathFromArg(pathArg);
    if (!path) return null;

    // Get handler name if it's a reference
    let handlerName: string | undefined;
    const lastArg = args[args.length - 1];
    if (lastArg?.type === 'identifier') {
      handlerName = lastArg.text;
    } else if (lastArg?.type === 'member_expression') {
      handlerName = lastArg.text;
    }

    // Extract middleware (arguments between path and handler)
    const middleware: string[] = [];
    for (let i = 1; i < args.length - 1; i++) {
      const arg = args[i];
      if (arg?.type === 'identifier') {
        middleware.push(arg.text);
      } else if (arg?.type === 'call_expression') {
        // Middleware factory like authenticate()
        const func = this.getChildByField(arg, 'function');
        if (func) {
          middleware.push(func.text);
        }
      }
    }

    const location = this.getLocation(callNode);
    const httpMethod = this.normalizeHttpMethod(methodName);

    const options: CreateEndpointOptions = {
      http_method: httpMethod,
      path,
      path_params: this.parsePathParams(path),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'express',
      handler_type: handlerName ? 'reference' : 'inline',
      middleware,
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (handlerName) options.handler_name = handlerName;

    return this.createEndpoint(options);
  }

  /**
   * Extract path from an argument node
   */
  private extractPathFromArg(node: Parser.SyntaxNode): string | null {
    // String literal
    if (node.type === 'string') {
      return this.extractStringValue(node);
    }

    // Template literal
    if (node.type === 'template_string') {
      // For template strings, try to extract the static parts
      let result = '';
      for (const child of node.children) {
        if (child.type === 'string_fragment' || child.type === 'template_chars') {
          result += child.text;
        } else if (child.type === 'template_substitution') {
          result += ':param'; // Represent dynamic parts as params
        }
      }
      return result || null;
    }

    return null;
  }
}
