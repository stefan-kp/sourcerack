/**
 * Flask Endpoint Extractor
 *
 * Extracts API endpoints from Flask Python applications.
 *
 * Supports:
 * - @app.route('/path', methods=['GET', 'POST'])
 * - @blueprint.route('/path')
 * - Function docstrings as descriptions
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
} from './types.js';

/**
 * Flask route decorator patterns
 */
const FLASK_ROUTE_PATTERNS = ['route', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/**
 * Flask endpoint extractor for Python
 */
export class FlaskExtractor extends EndpointExtractor {
  readonly framework: Framework = 'flask';
  readonly language = 'python';

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    // Check for Flask imports
    return imports.some((imp) =>
      imp.includes('flask') ||
      imp.includes('Flask') ||
      imp.includes('Blueprint')
    );
  }

  /**
   * Extract endpoints from Flask Python code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find decorated function definitions
    const decoratedDefs = this.findAllDescendantsByType(rootNode, 'decorated_definition');

    for (const node of decoratedDefs) {
      const endpoint = this.extractEndpointFromDecoratedDef(node, filePath);
      if (endpoint) {
        endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract endpoint from a decorated function definition
   */
  private extractEndpointFromDecoratedDef(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    // Find the route decorator
    const decorators = this.getChildrenByType(node, 'decorator');
    let routeDecorator: Parser.SyntaxNode | null = null;
    let httpMethods: HttpMethod[] = [];

    for (const decorator of decorators) {
      const result = this.parseRouteDecorator(decorator);
      if (result) {
        routeDecorator = decorator;
        httpMethods = result.methods;
        break;
      }
    }

    if (!routeDecorator || httpMethods.length === 0) {
      return null;
    }

    // Get the function definition
    const funcDef = this.getChildByField(node, 'definition');
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!funcDef || funcDef.type !== 'function_definition') {
      return null;
    }

    // Extract route path
    const path = this.extractRoutePath(routeDecorator);
    if (!path) {
      return null;
    }

    // Extract docstring
    const { summary, description } = this.extractDocstring(funcDef);

    // Get function name as handler
    const nameNode = this.getChildByField(funcDef, 'name');
    const handlerName = nameNode?.text ?? 'anonymous';

    // Get location
    const location = this.getLocation(node);

    // For Flask, if multiple methods are specified, create one endpoint with the primary method
    // or 'ALL' if it's a generic route
    const httpMethod: HttpMethod = httpMethods.length === 1 ? httpMethods[0]! : 'ALL';

    // Build the endpoint options
    const options: CreateEndpointOptions = {
      http_method: httpMethod,
      path,
      path_params: this.parsePathParams(path),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'flask',
      handler_name: handlerName,
      handler_type: 'reference',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (summary) options.summary = summary;
    if (description) options.description = description;

    return this.createEndpoint(options);
  }

  /**
   * Parse a Flask route decorator
   * Returns the HTTP methods if it's a valid route decorator
   */
  private parseRouteDecorator(decorator: Parser.SyntaxNode): { methods: HttpMethod[] } | null {
    // Get the decorator expression (after @)
    const children = decorator.children.filter(c => c.type !== '@');
    if (children.length === 0) return null;

    const expr = children[0];
    if (!expr) return null;

    // Handle @app.route(...) or @blueprint.route(...)
    if (expr.type === 'call') {
      const funcNode = this.getChildByField(expr, 'function');
      if (!funcNode) return null;

      // Check for member expression (app.route, bp.route, etc.)
      if (funcNode.type === 'attribute') {
        const attrNode = this.getChildByField(funcNode, 'attribute');
        if (!attrNode) return null;

        const methodName = attrNode.text.toLowerCase();

        // @app.route('/path', methods=['GET', 'POST'])
        if (methodName === 'route') {
          const methods = this.extractMethodsFromRouteDecorator(expr);
          return { methods: methods.length > 0 ? methods : ['GET'] };
        }

        // @app.get('/path'), @app.post('/path'), etc.
        if (FLASK_ROUTE_PATTERNS.includes(methodName) && methodName !== 'route') {
          return { methods: [this.normalizeHttpMethod(methodName)] };
        }
      }
    }

    return null;
  }

  /**
   * Extract HTTP methods from @app.route(..., methods=['GET', 'POST'])
   */
  private extractMethodsFromRouteDecorator(callNode: Parser.SyntaxNode): HttpMethod[] {
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return [];

    // Find the 'methods' keyword argument
    const keywordArgs = this.findAllDescendantsByType(argsNode, 'keyword_argument');

    for (const kwarg of keywordArgs) {
      const nameNode = this.getChildByField(kwarg, 'name');
      if (nameNode?.text === 'methods') {
        const valueNode = this.getChildByField(kwarg, 'value');
        if (valueNode?.type === 'list') {
          return this.extractMethodsFromList(valueNode);
        }
      }
    }

    return [];
  }

  /**
   * Extract HTTP methods from a list like ['GET', 'POST']
   */
  private extractMethodsFromList(listNode: Parser.SyntaxNode): HttpMethod[] {
    const methods: HttpMethod[] = [];

    for (const child of listNode.children) {
      if (child.type === 'string') {
        const value = this.extractStringValue(child);
        if (value) {
          methods.push(this.normalizeHttpMethod(value));
        }
      }
    }

    return methods;
  }

  /**
   * Extract route path from decorator
   */
  private extractRoutePath(decorator: Parser.SyntaxNode): string | null {
    // Find the call expression
    const callNode = this.findDescendantByType(decorator, 'call');
    if (!callNode) return null;

    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    // First positional argument is the path
    for (const child of argsNode.children) {
      if (child.type === 'string') {
        return this.extractStringValue(child);
      }
    }

    return null;
  }

  /**
   * Extract docstring from function definition
   */
  private extractDocstring(funcDef: Parser.SyntaxNode): { summary?: string; description?: string } {
    // Find the function body
    const body = this.getChildByField(funcDef, 'body');
    if (!body) return {};

    // First child of body might be an expression statement with a string (docstring)
    const firstStmt = body.children.find(c => c.type === 'expression_statement');
    if (!firstStmt) return {};

    const strNode = this.getFirstChildByType(firstStmt, 'string');
    if (!strNode) return {};

    const docstring = this.extractStringValue(strNode);
    if (!docstring) return {};

    // Parse docstring - first line is summary, rest is description
    const lines = docstring.trim().split('\n');
    const summary = lines[0]?.trim();
    const description = lines.length > 1 ? docstring.trim() : undefined;

    const result: { summary?: string; description?: string } = {};
    if (summary) result.summary = summary;
    if (description) result.description = description;

    return result;
  }
}
