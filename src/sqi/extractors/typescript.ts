/**
 * TypeScript/JavaScript Symbol Extractor for SQI
 *
 * Extracts symbols, usages, and imports from TypeScript, JavaScript, and TSX files.
 */

import Parser from 'tree-sitter';
import {
  SymbolKind,
  Visibility,
  UsageType,
  ExtractedSymbol,
  ExtractedUsage,
  ExtractedImport,
  ExtractedParameter,
  ExtractedDocstring,
  ExtractedImportBinding,
} from '../types.js';
import { SymbolExtractor, NodeTypeMapping } from './base.js';

/**
 * Node types that map to symbol kinds in TypeScript/JavaScript
 */
const TS_SYMBOL_TYPES: NodeTypeMapping = {
  // Functions
  function_declaration: SymbolKind.FUNCTION,
  function_expression: SymbolKind.FUNCTION,
  arrow_function: SymbolKind.FUNCTION,
  generator_function_declaration: SymbolKind.FUNCTION,

  // Classes
  class_declaration: SymbolKind.CLASS,
  class_expression: SymbolKind.CLASS,
  abstract_class_declaration: SymbolKind.CLASS,

  // Methods
  method_definition: SymbolKind.METHOD,
  public_field_definition: SymbolKind.FIELD,

  // TypeScript specific
  interface_declaration: SymbolKind.INTERFACE,
  type_alias_declaration: SymbolKind.TYPE_ALIAS,
  enum_declaration: SymbolKind.ENUM,
  namespace: SymbolKind.NAMESPACE,
  module: SymbolKind.MODULE,

  // Properties and variables
  property_signature: SymbolKind.PROPERTY,
  variable_declarator: SymbolKind.VARIABLE,
  lexical_declaration: SymbolKind.VARIABLE,
};

/**
 * Node types that represent usages/references
 */
const USAGE_NODE_TYPES = [
  'identifier',
  'property_identifier',
  'type_identifier',
];

/**
 * TypeScript/JavaScript symbol extractor
 */
export class TypeScriptExtractor extends SymbolExtractor {
  readonly language = 'typescript';
  readonly aliases = ['javascript', 'tsx', 'jsx'];

  /**
   * Extract symbols from TypeScript/JavaScript AST
   */
  protected extractSymbols(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    this.traverseForSymbols(rootNode, filePath, sourceCode, symbols);

    return symbols;
  }

  /**
   * Traverse AST to extract symbols
   */
  private traverseForSymbols(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    symbols: ExtractedSymbol[],
    parentQualifiedName?: string
  ): void {
    const symbolKind = TS_SYMBOL_TYPES[node.type];

    if (symbolKind) {
      const symbol = this.extractSymbolFromNode(
        node,
        filePath,
        sourceCode,
        symbolKind,
        parentQualifiedName
      );

      if (symbol) {
        symbols.push(symbol);

        // For classes and interfaces, extract children
        if (
          symbolKind === SymbolKind.CLASS ||
          symbolKind === SymbolKind.INTERFACE
        ) {
          const bodyNode = this.getChildByField(node, 'body');
          if (bodyNode) {
            symbol.children = [];
            for (const child of bodyNode.children) {
              this.traverseForSymbols(
                child,
                filePath,
                sourceCode,
                symbol.children,
                symbol.qualified_name
              );
            }
          }
          // Don't traverse children again
          return;
        }
      }
    }

    // Handle variable declarations specially
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      const declarators = this.getChildrenByType(node, 'variable_declarator');
      for (const declarator of declarators) {
        const symbol = this.extractVariableDeclarator(
          declarator,
          node,
          filePath,
          sourceCode,
          parentQualifiedName
        );
        if (symbol) {
          symbols.push(symbol);
        }
      }
      return;
    }

    // Handle export statements
    if (node.type === 'export_statement') {
      const declaration = this.getChildByField(node, 'declaration');
      if (declaration) {
        this.traverseForSymbols(
          declaration,
          filePath,
          sourceCode,
          symbols,
          parentQualifiedName
        );
      }
      return;
    }

    // Recurse into children
    for (const child of node.children) {
      this.traverseForSymbols(
        child,
        filePath,
        sourceCode,
        symbols,
        parentQualifiedName
      );
    }
  }

  /**
   * Extract symbol information from a node
   */
  private extractSymbolFromNode(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    kind: SymbolKind,
    parentQualifiedName?: string
  ): ExtractedSymbol | null {
    const name = this.extractSymbolName(node);
    if (!name) return null;

    const location = this.getLocation(node);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
    const visibility = this.extractVisibility(node);
    const isAsync = this.hasModifier(node, 'async');
    const isStatic = this.hasModifier(node, 'static');
    const isExported = this.isExported(node);
    const returnType = this.extractReturnType(node);
    const parameters = this.extractParameters(node);
    const docstring = this.extractDocstring(node, sourceCode);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility,
      is_async: isAsync,
      is_static: isStatic,
      is_exported: isExported,
      return_type: returnType,
      parameters,
      docstring,
      content_hash: this.generateContentHash(node.text),
    };
  }

  /**
   * Extract variable declarator as a symbol
   */
  private extractVariableDeclarator(
    declarator: Parser.SyntaxNode,
    parent: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName?: string
  ): ExtractedSymbol | null {
    const nameNode = this.getChildByField(declarator, 'name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const location = this.getLocation(declarator);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);

    // Check if it's an arrow function or function expression
    const value = this.getChildByField(declarator, 'value');
    let kind = SymbolKind.VARIABLE;
    let parameters: ExtractedParameter[] | undefined;
    let returnType: string | undefined;
    let isAsync = false;

    if (value) {
      if (value.type === 'arrow_function' || value.type === 'function_expression') {
        kind = SymbolKind.FUNCTION;
        parameters = this.extractParameters(value);
        returnType = this.extractReturnType(value);
        isAsync = this.hasModifier(value, 'async');
      }
    }

    // Check for const
    const isConst = parent.text.startsWith('const ');
    if (isConst && kind === SymbolKind.VARIABLE) {
      kind = SymbolKind.CONSTANT;
    }

    const isExported = this.isExported(parent);
    const docstring = this.extractDocstring(parent, sourceCode);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      is_exported: isExported,
      is_async: isAsync,
      return_type: returnType,
      parameters,
      docstring,
      content_hash: this.generateContentHash(declarator.text),
    };
  }

  /**
   * Extract symbol name from node
   */
  private extractSymbolName(node: Parser.SyntaxNode): string | null {
    // Try name field first
    const nameNode = this.getChildByField(node, 'name');
    if (nameNode) {
      return nameNode.text;
    }

    // For property/method definitions
    const keyNode = this.getChildByField(node, 'key');
    if (keyNode) {
      return keyNode.text;
    }

    // For anonymous functions, generate name from location
    if (node.type.includes('function') || node.type === 'arrow_function') {
      return `anonymous_${node.startPosition.row + 1}_${node.startPosition.column}`;
    }

    return null;
  }

  /**
   * Extract visibility modifier
   */
  private extractVisibility(node: Parser.SyntaxNode): Visibility | undefined {
    if (this.hasModifier(node, 'private')) return 'private';
    if (this.hasModifier(node, 'protected')) return 'protected';
    if (this.hasModifier(node, 'public')) return 'public';
    return undefined;
  }

  /**
   * Check for modifier
   */
  private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    // Check accessibility_modifier child
    for (const child of node.children) {
      if (
        child.type === 'accessibility_modifier' ||
        child.type === modifier
      ) {
        if (child.text === modifier) return true;
      }
      if (child.type === modifier) return true;
    }

    // Check if the node text starts with the modifier
    const text = node.text.trim();
    return text.startsWith(modifier + ' ');
  }

  /**
   * Check if symbol is exported
   */
  private isExported(node: Parser.SyntaxNode): boolean {
    // Check parent for export_statement
    if (node.parent?.type === 'export_statement') return true;

    // Check for export keyword in node
    return node.text.trim().startsWith('export ');
  }

  /**
   * Extract return type annotation
   */
  private extractReturnType(node: Parser.SyntaxNode): string | undefined {
    const returnType = this.getChildByField(node, 'return_type');
    if (returnType) {
      // Remove the colon prefix if present
      const text = returnType.text;
      return text.startsWith(':') ? text.slice(1).trim() : text;
    }
    return undefined;
  }

  /**
   * Extract function parameters
   */
  private extractParameters(node: Parser.SyntaxNode): ExtractedParameter[] | undefined {
    const params = this.getChildByField(node, 'parameters');
    if (!params) return undefined;

    const parameters: ExtractedParameter[] = [];
    let position = 0;

    for (const child of params.children) {
      if (
        child.type === 'required_parameter' ||
        child.type === 'optional_parameter' ||
        child.type === 'rest_parameter' ||
        child.type === 'identifier'
      ) {
        const param = this.extractParameter(child, position);
        if (param) {
          parameters.push(param);
          position++;
        }
      }
    }

    return parameters.length > 0 ? parameters : undefined;
  }

  /**
   * Extract single parameter
   */
  private extractParameter(
    node: Parser.SyntaxNode,
    position: number
  ): ExtractedParameter | null {
    let name: string;
    let typeAnnotation: string | undefined;
    const isOptional = node.type === 'optional_parameter';

    // Get parameter name
    const patternNode = this.getChildByField(node, 'pattern');
    if (patternNode) {
      name = patternNode.text;
    } else if (node.type === 'identifier') {
      name = node.text;
    } else {
      const nameNode = this.getFirstChildByType(node, 'identifier');
      if (!nameNode) return null;
      name = nameNode.text;
    }

    // Get type annotation
    const typeNode = this.getChildByField(node, 'type');
    if (typeNode) {
      typeAnnotation = typeNode.text;
      if (typeAnnotation.startsWith(':')) {
        typeAnnotation = typeAnnotation.slice(1).trim();
      }
    }

    return {
      position,
      name,
      type_annotation: typeAnnotation,
      is_optional: isOptional,
    };
  }

  /**
   * Extract JSDoc comment
   */
  private extractDocstring(
    node: Parser.SyntaxNode,
    sourceCode: string
  ): ExtractedDocstring | undefined {
    const comment = this.extractPrecedingComment(node, sourceCode);
    if (!comment) return undefined;

    // Check for JSDoc style
    if (comment.startsWith('/**')) {
      return {
        doc_type: 'jsdoc',
        raw_text: comment,
        description: this.parseJSDocDescription(comment),
      };
    }

    return undefined;
  }

  /**
   * Parse description from JSDoc comment
   */
  private parseJSDocDescription(comment: string): string | undefined {
    // Remove /** and */ and leading asterisks
    const lines = comment
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .filter((line) => !line.startsWith('@'));

    const description = lines.join(' ').trim();
    return description || undefined;
  }

  // ==================== Usage Extraction ====================

  /**
   * Extract usages/references from AST
   */
  protected extractUsages(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedUsage[] {
    const usages: ExtractedUsage[] = [];
    const seenLocations = new Set<string>();

    this.traverse(rootNode, (node) => {
      if (!USAGE_NODE_TYPES.includes(node.type)) return;

      // Skip if in definition context
      if (this.isInDefinitionContext(node)) return;

      const usage = this.extractUsageFromNode(node, filePath);
      if (usage) {
        // Deduplicate by location
        const key = `${usage.line}:${usage.column}:${usage.symbol_name}`;
        if (!seenLocations.has(key)) {
          seenLocations.add(key);
          usages.push(usage);
        }
      }
    });

    return usages;
  }

  /**
   * Check if node is in a definition context (should not be counted as usage)
   */
  private isInDefinitionContext(node: Parser.SyntaxNode): boolean {
    let current = node.parent;
    let depth = 0;

    while (current && depth < 5) {
      // Skip if this is a name field of a definition
      if (
        current.type === 'function_declaration' ||
        current.type === 'class_declaration' ||
        current.type === 'interface_declaration' ||
        current.type === 'type_alias_declaration' ||
        current.type === 'method_definition' ||
        current.type === 'enum_declaration'
      ) {
        const nameNode = this.getChildByField(current, 'name');
        if (nameNode?.id === node.id) return true;
      }

      // Skip variable declarator names
      if (current.type === 'variable_declarator') {
        const nameNode = this.getChildByField(current, 'name');
        if (nameNode?.id === node.id) return true;
      }

      // Skip import specifiers
      if (current.type === 'import_specifier') {
        return true;
      }

      // Skip formal parameters
      if (current.type === 'formal_parameters') {
        return true;
      }

      // Skip property definitions (as name)
      if (current.type === 'property_signature' || current.type === 'public_field_definition') {
        const nameNode = this.getChildByField(current, 'name') ??
                         this.getChildByField(current, 'key');
        if (nameNode?.id === node.id) return true;
      }

      current = current.parent;
      depth++;
    }

    return false;
  }

  /**
   * Extract usage from node
   */
  private extractUsageFromNode(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedUsage | null {
    const symbolName = node.text;
    if (!symbolName || symbolName.length === 0) return null;

    // Skip common JavaScript keywords and primitives
    const skipNames = [
      'undefined', 'null', 'true', 'false', 'this', 'super',
      'console', 'window', 'document', 'global', 'process',
      'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
      'Promise', 'Error', 'Date', 'RegExp', 'Map', 'Set',
    ];
    if (skipNames.includes(symbolName)) return null;

    const location = this.getLocation(node);
    const usageType = this.determineUsageType(node);
    const enclosingSymbol = this.findEnclosingSymbolName(node);

    return {
      symbol_name: symbolName,
      file_path: filePath,
      line: location.startLine,
      column: location.startColumn,
      usage_type: usageType,
      enclosing_symbol_qualified_name: enclosingSymbol,
    };
  }

  /**
   * Determine the type of usage
   */
  private determineUsageType(node: Parser.SyntaxNode): UsageType {
    const parent = node.parent;
    if (!parent) return 'read';

    // Function call
    if (parent.type === 'call_expression') {
      const func = this.getChildByField(parent, 'function');
      if (func && (func.id === node.id || func.text.endsWith(node.text))) {
        return 'call';
      }
    }

    // new expression
    if (parent.type === 'new_expression') {
      return 'instantiate';
    }

    // Assignment
    if (parent.type === 'assignment_expression') {
      const left = this.getChildByField(parent, 'left');
      if (left?.id === node.id) {
        return 'write';
      }
    }

    // extends clause
    if (parent.type === 'class_heritage' || parent.type === 'extends_clause') {
      return 'extend';
    }

    // implements clause
    if (parent.type === 'implements_clause') {
      return 'implement';
    }

    // Type annotation
    if (
      parent.type === 'type_annotation' ||
      parent.type === 'type_identifier' ||
      node.type === 'type_identifier'
    ) {
      return 'type_ref';
    }

    // Decorator
    if (parent.type === 'decorator') {
      return 'decorator';
    }

    return 'read';
  }

  /**
   * Find enclosing symbol qualified name
   */
  private findEnclosingSymbolName(node: Parser.SyntaxNode): string | undefined {
    const enclosingTypes = [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'arrow_function',
    ];

    const enclosing = this.findEnclosingSymbol(node, enclosingTypes);
    if (!enclosing) return undefined;

    const name = this.extractSymbolName(enclosing);
    if (!name) return undefined;

    // Build qualified name by walking up
    const parts: string[] = [name];
    let current = enclosing.parent;

    while (current) {
      if (current.type === 'class_declaration' || current.type === 'class_expression') {
        const className = this.extractSymbolName(current);
        if (className) {
          parts.unshift(className);
        }
      }
      current = current.parent;
    }

    return parts.join('.');
  }

  // ==================== Import Extraction ====================

  /**
   * Extract imports from AST
   */
  protected extractImports(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    // Find all import statements
    const importNodes = this.findAllDescendantsByType(rootNode, 'import_statement');

    for (const node of importNodes) {
      const importData = this.extractImportFromNode(node, filePath);
      if (importData) {
        imports.push(importData);
      }
    }

    // Handle dynamic imports
    const callExpressions = this.findAllDescendantsByType(rootNode, 'call_expression');
    for (const node of callExpressions) {
      const func = this.getChildByField(node, 'function');
      if (func?.type === 'import') {
        const importData = this.extractDynamicImport(node, filePath);
        if (importData) {
          imports.push(importData);
        }
      }
    }

    // Handle require() calls
    for (const node of callExpressions) {
      const func = this.getChildByField(node, 'function');
      if (func?.text === 'require') {
        const importData = this.extractRequireImport(node, filePath);
        if (importData) {
          imports.push(importData);
        }
      }
    }

    return imports;
  }

  /**
   * Extract import from import statement
   */
  private extractImportFromNode(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const location = this.getLocation(node);

    // Get module specifier
    const sourceNode = this.getChildByField(node, 'source');
    if (!sourceNode) return null;

    const moduleSpecifier = sourceNode.text.replace(/['"]/g, '');

    // Extract bindings
    const bindings: ExtractedImportBinding[] = [];
    let isTypeOnly = false;

    // Check for type-only import
    if (node.text.includes('import type')) {
      isTypeOnly = true;
    }

    // Default import
    const defaultImport = this.findDescendantByType(node, 'identifier');
    if (defaultImport && !this.isInsideNodeType(defaultImport, 'import_specifier')) {
      // Check if it's actually a default import (before 'from')
      const importClause = this.getFirstChildByType(node, 'import_clause');
      if (importClause) {
        const firstChild = importClause.children[0];
        if (firstChild?.type === 'identifier') {
          bindings.push({
            imported_name: 'default',
            local_name: firstChild.text,
            is_type_only: isTypeOnly,
          });
        }
      }
    }

    // Named imports
    const namedImports = this.findDescendantByType(node, 'named_imports');
    if (namedImports) {
      const specifiers = this.getChildrenByType(namedImports, 'import_specifier');
      for (const spec of specifiers) {
        const binding = this.extractImportSpecifier(spec, isTypeOnly);
        if (binding) {
          bindings.push(binding);
        }
      }
    }

    // Namespace import
    const namespaceImport = this.findDescendantByType(node, 'namespace_import');
    if (namespaceImport) {
      const alias = this.getFirstChildByType(namespaceImport, 'identifier');
      if (alias) {
        bindings.push({
          imported_name: '*',
          local_name: alias.text,
          is_type_only: isTypeOnly,
        });
      }
    }

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'es_import',
      module_specifier: moduleSpecifier,
      bindings,
    };
  }

  /**
   * Extract import specifier binding
   */
  private extractImportSpecifier(
    node: Parser.SyntaxNode,
    parentIsTypeOnly: boolean
  ): ExtractedImportBinding | null {
    const nameNode = this.getChildByField(node, 'name');
    const aliasNode = this.getChildByField(node, 'alias');

    if (!nameNode) return null;

    const importedName = nameNode.text;
    const localName = aliasNode ? aliasNode.text : importedName;

    // Check for type-only import specifier
    const isTypeOnly = parentIsTypeOnly || node.text.includes('type ');

    return {
      imported_name: importedName,
      local_name: localName,
      is_type_only: isTypeOnly,
    };
  }

  /**
   * Extract dynamic import
   */
  private extractDynamicImport(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const location = this.getLocation(node);
    const args = this.getChildByField(node, 'arguments');

    if (!args || args.children.length === 0) return null;

    const moduleArg = args.children.find(
      (c) => c.type === 'string' || c.type === 'template_string'
    );

    if (!moduleArg) return null;

    const moduleSpecifier = moduleArg.text.replace(/['"`]/g, '');

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'es_import',
      module_specifier: moduleSpecifier,
      bindings: [], // Dynamic imports don't have static bindings
    };
  }

  /**
   * Extract require() import
   */
  private extractRequireImport(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const location = this.getLocation(node);
    const args = this.getChildByField(node, 'arguments');

    if (!args || args.children.length === 0) return null;

    const moduleArg = args.children.find((c) => c.type === 'string');
    if (!moduleArg) return null;

    const moduleSpecifier = moduleArg.text.replace(/['"]/g, '');

    // Try to find variable binding
    const bindings: ExtractedImportBinding[] = [];
    const parent = node.parent;

    if (parent?.type === 'variable_declarator') {
      const nameNode = this.getChildByField(parent, 'name');
      if (nameNode) {
        if (nameNode.type === 'identifier') {
          bindings.push({
            imported_name: 'default',
            local_name: nameNode.text,
          });
        } else if (nameNode.type === 'object_pattern') {
          // Destructuring require
          for (const prop of nameNode.children) {
            if (prop.type === 'shorthand_property_identifier_pattern') {
              bindings.push({
                imported_name: prop.text,
                local_name: prop.text,
              });
            } else if (prop.type === 'pair_pattern') {
              const key = this.getChildByField(prop, 'key');
              const value = this.getChildByField(prop, 'value');
              if (key && value) {
                bindings.push({
                  imported_name: key.text,
                  local_name: value.text,
                });
              }
            }
          }
        }
      }
    }

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'commonjs',
      module_specifier: moduleSpecifier,
      bindings,
    };
  }
}
