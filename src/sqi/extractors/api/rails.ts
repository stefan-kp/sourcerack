/**
 * Rails Endpoint Extractor
 *
 * Extracts API endpoints from Rails routes.rb files.
 *
 * Supports:
 * - get '/path', to: 'controller#action'
 * - post '/path', to: 'controller#action'
 * - resources :users
 * - resources :users, only: [:index, :show]
 * - namespace :api do ... end
 * - scope '/api' do ... end
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
} from './types.js';

/**
 * HTTP methods used in Rails routes
 */
const RAILS_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/**
 * RESTful actions and their HTTP methods
 */
const RESTFUL_ACTIONS: Record<string, { method: HttpMethod; pathSuffix: string }> = {
  index: { method: 'GET', pathSuffix: '' },
  show: { method: 'GET', pathSuffix: '/:id' },
  new: { method: 'GET', pathSuffix: '/new' },
  create: { method: 'POST', pathSuffix: '' },
  edit: { method: 'GET', pathSuffix: '/:id/edit' },
  update: { method: 'PUT', pathSuffix: '/:id' },
  destroy: { method: 'DELETE', pathSuffix: '/:id' },
};

/**
 * Rails endpoint extractor for Ruby routes.rb
 */
export class RailsExtractor extends EndpointExtractor {
  readonly framework: Framework = 'rails';
  readonly language = 'ruby';

  /**
   * Check if this extractor can handle the file
   */
  canHandle(filePath: string, _imports: string[]): boolean {
    // Rails routes are in config/routes.rb
    return filePath.endsWith('routes.rb') || filePath.includes('config/routes');
  }

  /**
   * Extract endpoints from Rails routes.rb
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Process all method calls in the file
    this.processNode(rootNode, filePath, '', endpoints);

    return endpoints;
  }

  /**
   * Recursively process nodes to handle namespaces and scopes
   */
  private processNode(
    node: Parser.SyntaxNode,
    filePath: string,
    pathPrefix: string,
    endpoints: ExtractedEndpoint[]
  ): void {
    // Find all call nodes recursively (they can be deeply nested)
    const calls = this.findAllDescendantsByType(node, 'call');

    for (const call of calls) {
      // In Ruby AST, method name is in 'method' field or as first identifier child
      const methodNode = this.getChildByField(call, 'method') ||
                         this.getFirstChildByType(call, 'identifier');
      if (!methodNode) continue;

      const methodName = methodNode.text.toLowerCase();

      // Handle HTTP method routes
      if (RAILS_HTTP_METHODS.includes(methodName)) {
        const endpoint = this.extractHttpRoute(call, filePath, pathPrefix);
        if (endpoint) {
          endpoints.push(endpoint);
        }
      }
      // Handle resources
      else if (methodName === 'resources' || methodName === 'resource') {
        const resourceEndpoints = this.extractResources(call, filePath, pathPrefix, methodName === 'resource');
        endpoints.push(...resourceEndpoints);
      }
      // Handle namespace
      else if (methodName === 'namespace') {
        const namespacePrefix = this.extractNamespacePrefix(call);
        if (namespacePrefix) {
          const block = this.getChildByField(call, 'block');
          if (block) {
            this.processNode(block, filePath, pathPrefix + namespacePrefix, endpoints);
          }
        }
      }
      // Handle scope
      else if (methodName === 'scope') {
        const scopePrefix = this.extractScopePrefix(call);
        const block = this.getChildByField(call, 'block');
        if (block) {
          this.processNode(block, filePath, pathPrefix + scopePrefix, endpoints);
        }
      }
    }

    // Also process nested structures
    for (const child of node.children) {
      if (child.type === 'do_block' || child.type === 'block') {
        this.processNode(child, filePath, pathPrefix, endpoints);
      }
    }
  }

  /**
   * Extract a simple HTTP route like: get '/path', to: 'controller#action'
   */
  private extractHttpRoute(
    callNode: Parser.SyntaxNode,
    filePath: string,
    pathPrefix: string
  ): ExtractedEndpoint | null {
    // Get the method name (identifier or method field)
    const methodNode = this.getChildByField(callNode, 'method') ||
                       this.getFirstChildByType(callNode, 'identifier');
    if (!methodNode) return null;

    const methodName = methodNode.text.toLowerCase();

    // Get arguments - could be 'arguments' field or 'argument_list' child
    const argsNode = this.getChildByField(callNode, 'arguments') ||
                     this.getFirstChildByType(callNode, 'argument_list');
    if (!argsNode) return null;

    // Find the path
    let path: string | null = null;
    let handlerName: string | undefined;

    for (const child of argsNode.children) {
      // Path string
      if (child.type === 'string' && !path) {
        path = this.extractRubyString(child);
      }
      // Pair with to: 'controller#action'
      else if (child.type === 'pair') {
        // pair has structure: hash_key_symbol : string
        const keyNode = this.getFirstChildByType(child, 'hash_key_symbol') ||
                        this.getFirstChildByType(child, 'simple_symbol');
        const valueNode = this.findDescendantByType(child, 'string');
        if (keyNode && valueNode) {
          const keyText = keyNode.text.replace(/^:/, '');
          if (keyText === 'to') {
            handlerName = this.extractRubyString(valueNode) ?? undefined;
          }
        }
      }
      // Hash with to: 'controller#action'
      else if (child.type === 'hash') {
        const pairs = this.findAllDescendantsByType(child, 'pair');
        for (const pair of pairs) {
          const keyNode = this.getFirstChildByType(pair, 'hash_key_symbol') ||
                          this.getFirstChildByType(pair, 'simple_symbol');
          const valueNode = this.findDescendantByType(pair, 'string');
          if (keyNode && valueNode) {
            const keyText = keyNode.text.replace(/^:/, '');
            if (keyText === 'to') {
              handlerName = this.extractRubyString(valueNode) ?? undefined;
            }
          }
        }
      }
    }

    if (!path) return null;

    const fullPath = pathPrefix + (path.startsWith('/') ? path : '/' + path);
    const location = this.getLocation(callNode);

    const options: CreateEndpointOptions = {
      http_method: this.normalizeHttpMethod(methodName),
      path: fullPath,
      path_params: this.parsePathParams(fullPath),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'rails',
      handler_type: 'controller_action',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (handlerName) options.handler_name = handlerName;

    return this.createEndpoint(options);
  }

  /**
   * Extract RESTful resources
   */
  private extractResources(
    callNode: Parser.SyntaxNode,
    filePath: string,
    pathPrefix: string,
    singular: boolean
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return endpoints;

    // Get resource name
    let resourceName: string | null = null;
    let onlyActions: string[] | null = null;
    let exceptActions: string[] | null = null;

    for (const child of argsNode.children) {
      // Symbol :users
      if (child.type === 'simple_symbol' || child.type === 'symbol') {
        resourceName = child.text.replace(/^:/, '');
      }
      // Hash with options
      else if (child.type === 'hash') {
        const pairs = this.findAllDescendantsByType(child, 'pair');
        for (const pair of pairs) {
          const key = pair.children[0];
          const value = pair.children[2] || pair.children[1];
          if (!key || !value) continue;

          const keyText = key.text.replace(/^:/, '');
          if (keyText === 'only' && value.type === 'array') {
            onlyActions = this.extractSymbolArray(value);
          } else if (keyText === 'except' && value.type === 'array') {
            exceptActions = this.extractSymbolArray(value);
          }
        }
      }
    }

    if (!resourceName) return endpoints;

    const basePath = pathPrefix + '/' + resourceName;
    const location = this.getLocation(callNode);

    // Determine which actions to generate
    let actions = Object.keys(RESTFUL_ACTIONS);
    if (onlyActions) {
      actions = actions.filter(a => onlyActions.includes(a));
    }
    if (exceptActions) {
      actions = actions.filter(a => !exceptActions.includes(a));
    }

    // For singular resources, don't include index and use different paths
    if (singular) {
      actions = actions.filter(a => a !== 'index');
    }

    for (const action of actions) {
      const actionInfo = RESTFUL_ACTIONS[action];
      if (!actionInfo) continue;

      const path = singular
        ? pathPrefix + '/' + resourceName + (actionInfo.pathSuffix === '/:id' ? '' : actionInfo.pathSuffix.replace('/:id', ''))
        : basePath + actionInfo.pathSuffix;

      endpoints.push(this.createEndpoint({
        http_method: actionInfo.method,
        path,
        path_params: this.parsePathParams(path),
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        framework: 'rails',
        handler_name: `${resourceName}#${action}`,
        handler_type: 'controller_action',
        middleware: [],
        dependencies: [],
        tags: [],
        query_params: [],
      }));
    }

    // Process nested resources in block
    const block = this.getChildByField(callNode, 'block');
    if (block) {
      this.processNode(block, filePath, basePath, endpoints);
    }

    return endpoints;
  }

  /**
   * Extract namespace prefix
   */
  private extractNamespacePrefix(callNode: Parser.SyntaxNode): string | null {
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    for (const child of argsNode.children) {
      if (child.type === 'simple_symbol' || child.type === 'symbol') {
        return '/' + child.text.replace(/^:/, '');
      }
    }

    return null;
  }

  /**
   * Extract scope prefix
   */
  private extractScopePrefix(callNode: Parser.SyntaxNode): string {
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return '';

    for (const child of argsNode.children) {
      if (child.type === 'string') {
        const path = this.extractRubyString(child);
        if (path) return path.startsWith('/') ? path : '/' + path;
      }
    }

    return '';
  }

  /**
   * Extract array of symbols
   */
  private extractSymbolArray(arrayNode: Parser.SyntaxNode): string[] {
    const symbols: string[] = [];
    for (const child of arrayNode.children) {
      if (child.type === 'simple_symbol' || child.type === 'symbol') {
        symbols.push(child.text.replace(/^:/, ''));
      }
    }
    return symbols;
  }

  /**
   * Extract string value from Ruby string node
   */
  private extractRubyString(node: Parser.SyntaxNode): string | null {
    if (node.type === 'string_content') {
      return node.text;
    }

    const content = this.findDescendantByType(node, 'string_content');
    if (content) {
      return content.text;
    }

    const text = node.text;
    if ((text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1);
    }

    return text;
  }
}
