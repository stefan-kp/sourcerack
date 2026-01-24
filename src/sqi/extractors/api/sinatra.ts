/**
 * Sinatra Endpoint Extractor
 *
 * Extracts API endpoints from Sinatra Ruby applications.
 *
 * Supports:
 * - get '/path' do ... end
 * - post '/path' do ... end
 * - put '/path' do ... end
 * - delete '/path' do ... end
 */

import Parser from 'tree-sitter';
import { EndpointExtractor } from './base.js';
import {
  Framework,
  ExtractedEndpoint,
} from './types.js';

/**
 * HTTP methods used in Sinatra
 */
const SINATRA_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/**
 * Sinatra endpoint extractor for Ruby
 */
export class SinatraExtractor extends EndpointExtractor {
  readonly framework: Framework = 'sinatra';
  readonly language = 'ruby';

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) =>
      imp === 'sinatra' ||
      imp === 'sinatra/base'
    );
  }

  /**
   * Extract endpoints from Sinatra code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find all method calls (Sinatra uses method call syntax)
    const calls = this.findAllDescendantsByType(rootNode, 'call');

    for (const call of calls) {
      const endpoint = this.extractEndpointFromCall(call, filePath);
      if (endpoint) {
        endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract endpoint from a Sinatra route definition
   * Pattern: get '/path' do ... end
   */
  private extractEndpointFromCall(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    // Get the method name (get, post, etc.)
    const methodNode = this.getChildByField(callNode, 'method');
    if (!methodNode) return null;

    const methodName = methodNode.text.toLowerCase();
    if (!SINATRA_HTTP_METHODS.includes(methodName)) return null;

    // Get the arguments (should contain the path)
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    // Find the path string
    let path: string | null = null;
    for (const child of argsNode.children) {
      if (child.type === 'string' || child.type === 'string_content') {
        path = this.extractRubyString(child);
        if (path) break;
      }
    }

    // Also check for simple_string in argument list
    const stringNode = this.findDescendantByType(argsNode, 'string');
    if (!path && stringNode) {
      path = this.extractRubyString(stringNode);
    }

    if (!path) return null;

    const location = this.getLocation(callNode);

    return this.createEndpoint({
      http_method: this.normalizeHttpMethod(methodName),
      path,
      path_params: this.parsePathParams(path),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'sinatra',
      handler_type: 'inline',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    });
  }

  /**
   * Extract string value from Ruby string node
   */
  private extractRubyString(node: Parser.SyntaxNode): string | null {
    if (node.type === 'string_content') {
      return node.text;
    }

    // For quoted strings, find the content
    const content = this.findDescendantByType(node, 'string_content');
    if (content) {
      return content.text;
    }

    // Fallback: remove quotes manually
    const text = node.text;
    if ((text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1);
    }

    return text;
  }
}
