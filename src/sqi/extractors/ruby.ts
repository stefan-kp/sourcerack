/**
 * Ruby Symbol Extractor for SQI
 *
 * Extracts symbols, usages, and imports from Ruby files.
 *
 * Supports:
 * - Classes (with inheritance)
 * - Modules
 * - Methods (instance and singleton/class methods)
 * - Attr accessors (attr_reader, attr_writer, attr_accessor)
 * - Constants
 * - Require/require_relative statements
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
} from '../types.js';
import { SymbolExtractor, NodeTypeMapping } from './base.js';

/**
 * Node types that map to symbol kinds in Ruby
 */
const RUBY_SYMBOL_TYPES: NodeTypeMapping = {
  // Classes
  class: SymbolKind.CLASS,

  // Modules
  module: SymbolKind.MODULE,

  // Methods
  method: SymbolKind.METHOD,
  singleton_method: SymbolKind.METHOD,
};

/**
 * Node types that represent usages/references
 */
const USAGE_NODE_TYPES = ['identifier', 'constant'];

/**
 * Ruby built-in names to skip in usage tracking
 */
const RUBY_BUILTINS = new Set([
  // Keywords and special values
  'nil',
  'true',
  'false',
  'self',
  'super',
  '__FILE__',
  '__LINE__',
  '__ENCODING__',
  // Core classes
  'Object',
  'BasicObject',
  'Module',
  'Class',
  'String',
  'Integer',
  'Float',
  'Array',
  'Hash',
  'Symbol',
  'Proc',
  'Lambda',
  'Method',
  'Range',
  'Regexp',
  'Time',
  'Date',
  'DateTime',
  'File',
  'Dir',
  'IO',
  'Struct',
  'OpenStruct',
  'Enumerable',
  'Enumerator',
  'Comparable',
  'Kernel',
  // Common methods
  'puts',
  'print',
  'p',
  'pp',
  'gets',
  'raise',
  'fail',
  'require',
  'require_relative',
  'load',
  'include',
  'extend',
  'prepend',
  'attr_reader',
  'attr_writer',
  'attr_accessor',
  'private',
  'protected',
  'public',
  'alias_method',
  'define_method',
  'class_eval',
  'instance_eval',
  'module_eval',
  'send',
  'public_send',
  '__send__',
  'respond_to?',
  'method_defined?',
  'instance_variable_get',
  'instance_variable_set',
  // Iterators
  'each',
  'map',
  'select',
  'reject',
  'find',
  'reduce',
  'inject',
  'collect',
  'detect',
  'sort',
  'sort_by',
  'group_by',
  'partition',
  'flatten',
  'compact',
  'uniq',
  'reverse',
  'first',
  'last',
  'take',
  'drop',
  'any?',
  'all?',
  'none?',
  'one?',
  'empty?',
  'count',
  'size',
  'length',
  // Common methods
  'new',
  'initialize',
  'to_s',
  'to_i',
  'to_f',
  'to_a',
  'to_h',
  'to_sym',
  'inspect',
  'class',
  'is_a?',
  'kind_of?',
  'instance_of?',
  'nil?',
  'present?',
  'blank?',
  'freeze',
  'frozen?',
  'dup',
  'clone',
  'tap',
  'then',
  'yield_self',
  // Exceptions
  'Exception',
  'StandardError',
  'RuntimeError',
  'ArgumentError',
  'TypeError',
  'NameError',
  'NoMethodError',
  'NotImplementedError',
  'IOError',
  'SystemCallError',
]);

/**
 * Ruby symbol extractor
 */
export class RubyExtractor extends SymbolExtractor {
  readonly language = 'ruby';
  readonly aliases: string[] = [];

  /**
   * Extract symbols from Ruby AST
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
    const symbolKind = RUBY_SYMBOL_TYPES[node.type];

    if (symbolKind) {
      const symbol = this.extractSymbolFromDefinition(
        node,
        filePath,
        sourceCode,
        parentQualifiedName
      );

      if (symbol) {
        symbols.push(symbol);

        // For classes and modules, extract children
        if (symbolKind === SymbolKind.CLASS || symbolKind === SymbolKind.MODULE) {
          const bodyNode = this.getChildByField(node, 'body');
          if (bodyNode) {
            symbol.children = [];
            this.extractChildSymbols(
              bodyNode,
              filePath,
              sourceCode,
              symbol.children,
              symbol.qualified_name
            );
          }
        }
        return;
      }
    }

    // Handle constant assignments at module level (CONSTANT = value)
    if (node.type === 'assignment' && !parentQualifiedName) {
      const constSymbol = this.extractConstantFromAssignment(node, filePath, sourceCode);
      if (constSymbol) {
        symbols.push(constSymbol);
        return;
      }
    }

    // Recurse into children at program level
    if (node.type === 'program') {
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
  }

  /**
   * Extract child symbols from a class or module body
   */
  private extractChildSymbols(
    bodyNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    symbols: ExtractedSymbol[],
    parentQualifiedName: string
  ): void {
    for (const child of bodyNode.children) {
      const symbolKind = RUBY_SYMBOL_TYPES[child.type];

      if (symbolKind) {
        const symbol = this.extractSymbolFromDefinition(
          child,
          filePath,
          sourceCode,
          parentQualifiedName
        );

        if (symbol) {
          symbols.push(symbol);

          // Nested classes/modules
          if (symbolKind === SymbolKind.CLASS || symbolKind === SymbolKind.MODULE) {
            const nestedBody = this.getChildByField(child, 'body');
            if (nestedBody) {
              symbol.children = [];
              this.extractChildSymbols(
                nestedBody,
                filePath,
                sourceCode,
                symbol.children,
                symbol.qualified_name
              );
            }
          }
        }
      }

      // Handle attr_* declarations
      if (child.type === 'call') {
        const attrSymbols = this.extractAttrAccessors(
          child,
          filePath,
          sourceCode,
          parentQualifiedName
        );
        symbols.push(...attrSymbols);
      }

      // Handle constant assignments inside class/module
      if (child.type === 'assignment') {
        const constSymbol = this.extractConstantFromAssignment(
          child,
          filePath,
          sourceCode,
          parentQualifiedName
        );
        if (constSymbol) {
          symbols.push(constSymbol);
        }
      }
    }
  }

  /**
   * Extract symbol from a class, module, or method definition
   */
  private extractSymbolFromDefinition(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName?: string
  ): ExtractedSymbol | null {
    let name: string;
    let symbolKind: SymbolKind;
    let isStatic = false;

    switch (node.type) {
      case 'class': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        symbolKind = SymbolKind.CLASS;
        break;
      }

      case 'module': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        symbolKind = SymbolKind.MODULE;
        break;
      }

      case 'method': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        symbolKind = SymbolKind.METHOD;
        break;
      }

      case 'singleton_method': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        symbolKind = SymbolKind.METHOD;
        isStatic = true;
        break;
      }

      default:
        return null;
    }

    const location = this.getLocation(node);
    const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${name}` : name;

    // Get visibility
    const visibility = this.determineVisibility(name, node);

    // Get parameters for methods
    let parameters: ExtractedParameter[] | undefined;
    if (symbolKind === SymbolKind.METHOD) {
      parameters = this.extractParameters(node);
    }

    // Extract docstring (Ruby uses comments above the definition)
    const docstring = this.extractDocstring(node, sourceCode);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: symbolKind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility,
      is_exported: true, // Ruby doesn't have export concept
      is_static: isStatic,
      is_async: false,
      parameters,
      docstring,
      content_hash: this.generateContentHash(node.text),
    };
  }

  /**
   * Extract constant from assignment
   */
  private extractConstantFromAssignment(
    node: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string,
    parentQualifiedName?: string
  ): ExtractedSymbol | null {
    const leftNode = this.getChildByField(node, 'left');
    if (leftNode?.type !== 'constant') return null;

    const name = leftNode.text;
    const location = this.getLocation(node);
    const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${name}` : name;

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: SymbolKind.CONSTANT,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: 'public',
      is_exported: true,
      is_static: true,
      is_async: false,
      content_hash: this.generateContentHash(node.text),
    };
  }

  /**
   * Extract attr_reader, attr_writer, attr_accessor
   */
  private extractAttrAccessors(
    node: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string,
    parentQualifiedName: string
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    // Check if this is an attr_* call
    const methodNode = this.getChildByField(node, 'method');
    if (!methodNode) return symbols;

    const methodName = methodNode.text;
    if (!['attr_reader', 'attr_writer', 'attr_accessor'].includes(methodName)) {
      return symbols;
    }

    // Get the arguments (symbol names)
    const argsNode = this.getChildByField(node, 'arguments');
    if (!argsNode) return symbols;

    for (const arg of argsNode.children) {
      if (arg.type === 'simple_symbol' || arg.type === 'symbol') {
        // Remove the leading colon
        let attrName = arg.text;
        if (attrName.startsWith(':')) {
          attrName = attrName.slice(1);
        }

        const location = this.getLocation(arg);
        const qualifiedName = `${parentQualifiedName}.${attrName}`;

        symbols.push({
          name: attrName,
          qualified_name: qualifiedName,
          symbol_kind: SymbolKind.PROPERTY,
          file_path: filePath,
          start_line: location.startLine,
          end_line: location.endLine,
          visibility: 'public',
          is_exported: true,
          is_static: false,
          is_async: false,
          content_hash: this.generateContentHash(arg.text),
        });
      }
    }

    return symbols;
  }

  /**
   * Determine visibility of a symbol
   */
  private determineVisibility(name: string, _node: Parser.SyntaxNode): Visibility {
    // Ruby convention: methods starting with _ are considered private
    // Methods ending with ? or ! are typically public
    if (name.startsWith('_') && !name.startsWith('__')) {
      return 'private';
    }
    // Note: Ruby also has public/private/protected keywords that modify visibility
    // but detecting that requires more context (tracking current visibility state)
    return 'public';
  }

  /**
   * Extract parameters from a method
   */
  private extractParameters(node: Parser.SyntaxNode): ExtractedParameter[] {
    const params: ExtractedParameter[] = [];
    const paramsNode = this.getChildByField(node, 'parameters');
    if (!paramsNode) return params;

    let position = 0;
    for (const child of paramsNode.children) {
      const param = this.extractParameter(child, position);
      if (param) {
        params.push(param);
        position++;
      }
    }

    return params;
  }

  /**
   * Extract a single parameter
   */
  private extractParameter(
    node: Parser.SyntaxNode,
    position: number
  ): ExtractedParameter | null {
    let name: string;
    let isOptional = false;

    switch (node.type) {
      case 'identifier': {
        name = node.text;
        break;
      }

      case 'optional_parameter': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        isOptional = true;
        break;
      }

      case 'splat_parameter': {
        // *args
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = '*' + nameNode.text;
        break;
      }

      case 'hash_splat_parameter': {
        // **kwargs
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = '**' + nameNode.text;
        break;
      }

      case 'block_parameter': {
        // &block
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = '&' + nameNode.text;
        break;
      }

      case 'keyword_parameter': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text + ':';
        // Check if has default value
        const valueNode = this.getChildByField(node, 'value');
        isOptional = valueNode !== null;
        break;
      }

      default:
        return null;
    }

    return {
      position,
      name,
      is_optional: isOptional,
    };
  }

  /**
   * Extract docstring from method/class (Ruby uses comments)
   */
  private extractDocstring(
    node: Parser.SyntaxNode,
    sourceCode: string
  ): ExtractedDocstring | undefined {
    // Look for comment(s) immediately before the node
    const startLine = node.startPosition.row;
    const lines = sourceCode.split('\n');

    const commentLines: string[] = [];
    let lineIndex = startLine - 1;

    // Collect consecutive comment lines before the definition
    while (lineIndex >= 0) {
      const line = lines[lineIndex]?.trim() ?? '';
      if (line.startsWith('#')) {
        // Remove # and leading space
        const commentContent = line.replace(/^#\s?/, '');
        commentLines.unshift(commentContent);
        lineIndex--;
      } else if (line === '') {
        // Skip empty lines between comments and definition
        lineIndex--;
      } else {
        break;
      }
    }

    if (commentLines.length === 0) return undefined;

    const rawText = commentLines.map((l) => '# ' + l).join('\n');
    const description = commentLines.join(' ').trim();

    return {
      doc_type: 'rdoc',
      raw_text: rawText,
      description,
    };
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
   * Check if node is in a definition context
   */
  private isInDefinitionContext(node: Parser.SyntaxNode): boolean {
    let current = node.parent;
    let depth = 0;

    while (current && depth < 5) {
      // Skip if this is a name field of a definition
      if (
        current.type === 'class' ||
        current.type === 'module' ||
        current.type === 'method' ||
        current.type === 'singleton_method'
      ) {
        const nameNode = this.getChildByField(current, 'name');
        if (nameNode?.id === node.id) return true;
      }

      // Skip parameter definitions
      if (
        current.type === 'method_parameters' ||
        current.type === 'block_parameters'
      ) {
        return true;
      }

      // Skip require statements
      if (current.type === 'call') {
        const methodNode = this.getChildByField(current, 'method');
        if (
          methodNode &&
          (methodNode.text === 'require' || methodNode.text === 'require_relative')
        ) {
          return true;
        }
      }

      // Skip assignment left side
      if (current.type === 'assignment') {
        const left = this.getChildByField(current, 'left');
        if (left?.id === node.id) return true;
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

    // Skip Ruby builtins
    if (RUBY_BUILTINS.has(symbolName)) return null;

    // Skip lowercase identifiers that are likely local variables
    if (node.type === 'identifier' && /^[a-z_][a-z0-9_]*$/.test(symbolName)) {
      // Could be a local variable - skip very common patterns
      if (symbolName.length <= 2) return null;
    }

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

    // Method call - check if this node IS the method being called
    if (parent.type === 'call') {
      const methodNode = this.getChildByField(parent, 'method');
      if (methodNode?.id === node.id) {
        return 'call';
      }
      // Also check for identifier child (Ruby grammar uses this sometimes)
      const identifierChild = parent.children.find((c) => c.type === 'identifier');
      if (identifierChild?.id === node.id) {
        return 'call';
      }
    }

    // Class instantiation (Foo.new)
    if (parent.type === 'call') {
      const methodNode = this.getChildByField(parent, 'method');
      if (methodNode?.text === 'new') {
        const receiver = this.getChildByField(parent, 'receiver');
        if (receiver?.id === node.id) {
          return 'instantiate';
        }
      }
    }

    // Class inheritance
    if (parent.type === 'superclass') {
      return 'extend';
    }

    // Module include/extend/prepend - the constant is inside argument_list
    if (parent.type === 'argument_list') {
      const callNode = parent.parent;
      if (callNode?.type === 'call') {
        const methodName = this.getCallMethodName(callNode);
        if (methodName === 'include' || methodName === 'extend' || methodName === 'prepend') {
          return 'extend';
        }
      }
    }

    // Also check direct parent call (for method field cases)
    if (parent.type === 'call') {
      const methodName = this.getCallMethodName(parent);
      if (methodName === 'include' || methodName === 'extend' || methodName === 'prepend') {
        return 'extend';
      }
    }

    return 'read';
  }

  /**
   * Get the method name from a call node
   * Ruby grammar uses either 'method' field or direct 'identifier' child
   */
  private getCallMethodName(callNode: Parser.SyntaxNode): string | null {
    // Try field first
    const methodNode = this.getChildByField(callNode, 'method');
    if (methodNode) {
      return methodNode.text;
    }
    // Fall back to identifier child
    const identifierChild = callNode.children.find((c) => c.type === 'identifier');
    return identifierChild?.text ?? null;
  }

  /**
   * Find enclosing symbol qualified name
   */
  private findEnclosingSymbolName(node: Parser.SyntaxNode): string | undefined {
    const enclosingTypes = ['method', 'singleton_method', 'class', 'module'];
    const enclosing = this.findEnclosingSymbol(node, enclosingTypes);

    if (!enclosing) return undefined;

    const nameNode = this.getChildByField(enclosing, 'name');
    if (!nameNode) return undefined;

    const name = nameNode.text;

    // Build qualified name by walking up
    const parts: string[] = [name];
    let current = enclosing.parent;

    while (current) {
      if (current.type === 'class' || current.type === 'module') {
        const classNameNode = this.getChildByField(current, 'name');
        if (classNameNode) {
          parts.unshift(classNameNode.text);
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

    this.traverse(rootNode, (node) => {
      if (node.type === 'call') {
        const importData = this.extractRequireStatement(node, filePath);
        if (importData) {
          imports.push(importData);
        }
      }
    });

    return imports;
  }

  /**
   * Extract from require/require_relative statement
   */
  private extractRequireStatement(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const methodNode = this.getChildByField(node, 'method');
    if (!methodNode) return null;

    const methodName = methodNode.text;
    if (methodName !== 'require' && methodName !== 'require_relative') {
      return null;
    }

    const argsNode = this.getChildByField(node, 'arguments');
    if (!argsNode) return null;

    // Get the first argument (the module path)
    const firstArg = argsNode.children.find(
      (c) => c.type === 'string' || c.type === 'string_content'
    );
    if (!firstArg) return null;

    // Extract string content
    let moduleSpecifier = firstArg.text;
    // Remove quotes if present
    if (
      (moduleSpecifier.startsWith('"') && moduleSpecifier.endsWith('"')) ||
      (moduleSpecifier.startsWith("'") && moduleSpecifier.endsWith("'"))
    ) {
      moduleSpecifier = moduleSpecifier.slice(1, -1);
    }

    const location = this.getLocation(node);

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: methodName === 'require_relative' ? 'require_relative' : 'require',
      module_specifier: moduleSpecifier,
      bindings: [
        {
          imported_name: moduleSpecifier,
          local_name: moduleSpecifier.split('/').pop() ?? moduleSpecifier,
        },
      ],
    };
  }
}
