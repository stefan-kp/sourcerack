/**
 * NestJS Endpoint Extractor
 *
 * Extracts API endpoints from NestJS controllers.
 *
 * Supports:
 * - @Controller('prefix')
 * - @Get('/path')
 * - @Post('/path')
 * - @Put('/path')
 * - @Patch('/path')
 * - @Delete('/path')
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions } from './base.js';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
} from './types.js';

/**
 * NestJS HTTP method decorators
 */
const NESTJS_HTTP_DECORATORS: Record<string, HttpMethod> = {
  'Get': 'GET',
  'Post': 'POST',
  'Put': 'PUT',
  'Patch': 'PATCH',
  'Delete': 'DELETE',
  'Options': 'OPTIONS',
  'Head': 'HEAD',
  'All': 'ALL',
};

/**
 * NestJS endpoint extractor for TypeScript
 */
export class NestJSExtractor extends EndpointExtractor {
  readonly framework: Framework = 'nestjs';
  readonly language = 'typescript';
  readonly aliases = ['tsx'];

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) => imp.startsWith('@nestjs/'));
  }

  /**
   * Extract endpoints from NestJS controller
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find all class declarations
    const classDeclarations = this.findAllDescendantsByType(rootNode, 'class_declaration');

    for (const classDecl of classDeclarations) {
      // Check if it has a @Controller decorator
      const controllerPrefix = this.extractControllerPrefix(classDecl);
      if (controllerPrefix === null) continue; // Not a controller

      // Find all methods with HTTP decorators
      const classBody = this.getChildByField(classDecl, 'body');
      if (!classBody) continue;

      const methods = this.findAllDescendantsByType(classBody, 'method_definition');

      for (const method of methods) {
        const endpoint = this.extractEndpointFromMethod(method, filePath, controllerPrefix);
        if (endpoint) {
          endpoints.push(endpoint);
        }
      }
    }

    return endpoints;
  }

  /**
   * Extract the controller prefix from @Controller decorator
   */
  private extractControllerPrefix(classDecl: Parser.SyntaxNode): string | null {
    // Find decorators before the class
    const parent = classDecl.parent;
    if (!parent) return null;

    // Look for decorator pattern
    let decoratorNode: Parser.SyntaxNode | null = null;

    // Check if there's a decorator before the class
    const siblings = parent.children;
    const classIndex = siblings.indexOf(classDecl);

    for (let i = classIndex - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling?.type === 'decorator') {
        decoratorNode = sibling;
        break;
      }
      // Stop if we hit something that's not whitespace/comment/decorator
      if (sibling && !['comment', 'decorator'].includes(sibling.type)) {
        break;
      }
    }

    // Also check for export_statement wrapping
    if (!decoratorNode && parent.type === 'export_statement') {
      const grandParent = parent.parent;
      if (grandParent) {
        const parentIndex = grandParent.children.indexOf(parent);
        for (let i = parentIndex - 1; i >= 0; i--) {
          const sibling = grandParent.children[i];
          if (sibling?.type === 'decorator') {
            decoratorNode = sibling;
            break;
          }
        }
      }
    }

    if (!decoratorNode) {
      // Try finding decorator as child of class declaration (different AST structure)
      const decorators = this.findAllDescendantsByType(classDecl, 'decorator');
      for (const dec of decorators) {
        if (this.isControllerDecorator(dec)) {
          decoratorNode = dec;
          break;
        }
      }
    }

    if (!decoratorNode) return null;

    // Check if it's @Controller
    if (!this.isControllerDecorator(decoratorNode)) return null;

    // Extract the prefix
    const callExpr = this.findDescendantByType(decoratorNode, 'call_expression');
    if (!callExpr) return ''; // @Controller() with no args

    const argsNode = this.getChildByField(callExpr, 'arguments');
    if (!argsNode) return '';

    // Find string argument
    for (const child of argsNode.children) {
      if (child.type === 'string') {
        const value = this.extractStringValue(child);
        if (value !== null) return value;
      }
    }

    return '';
  }

  /**
   * Check if decorator is @Controller
   */
  private isControllerDecorator(decorator: Parser.SyntaxNode): boolean {
    const text = decorator.text;
    return text.includes('@Controller');
  }

  /**
   * Extract endpoint from a method with HTTP decorator
   */
  private extractEndpointFromMethod(
    methodNode: Parser.SyntaxNode,
    filePath: string,
    controllerPrefix: string
  ): ExtractedEndpoint | null {
    // Find HTTP method decorator
    let httpMethod: HttpMethod | null = null;
    let methodPath = '';

    // Look for decorators before the method
    const parent = methodNode.parent;
    if (!parent) return null;

    const siblings = parent.children;
    const methodIndex = siblings.indexOf(methodNode);

    for (let i = methodIndex - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling?.type === 'decorator') {
        const result = this.parseHttpDecorator(sibling);
        if (result) {
          httpMethod = result.method;
          methodPath = result.path;
          break;
        }
      }
      // Stop if we hit something that's not a decorator
      if (sibling && !['comment', 'decorator'].includes(sibling.type)) {
        break;
      }
    }

    if (!httpMethod) return null;

    // Get method name
    const nameNode = this.getChildByField(methodNode, 'name');
    const handlerName = nameNode?.text;

    // Build full path
    const fullPath = '/' + [controllerPrefix, methodPath]
      .filter(p => p)
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');

    const location = this.getLocation(methodNode);

    const options: CreateEndpointOptions = {
      http_method: httpMethod,
      path: '/' + fullPath,
      path_params: this.parsePathParams(fullPath),
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'nestjs',
      handler_type: 'class_method',
      middleware: [],
      dependencies: [],
      tags: [],
      query_params: [],
    };

    if (handlerName) options.handler_name = handlerName;

    return this.createEndpoint(options);
  }

  /**
   * Parse HTTP method decorator (@Get, @Post, etc.)
   */
  private parseHttpDecorator(decorator: Parser.SyntaxNode): { method: HttpMethod; path: string } | null {
    const text = decorator.text;

    for (const [decoratorName, httpMethod] of Object.entries(NESTJS_HTTP_DECORATORS)) {
      if (text.includes(`@${decoratorName}`)) {
        // Extract path from decorator argument
        const callExpr = this.findDescendantByType(decorator, 'call_expression');
        let path = '';

        if (callExpr) {
          const argsNode = this.getChildByField(callExpr, 'arguments');
          if (argsNode) {
            for (const child of argsNode.children) {
              if (child.type === 'string') {
                const value = this.extractStringValue(child);
                if (value !== null) {
                  path = value;
                  break;
                }
              }
            }
          }
        }

        return { method: httpMethod, path };
      }
    }

    return null;
  }
}
