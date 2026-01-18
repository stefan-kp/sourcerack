import { describe, it, expect, beforeAll } from 'vitest';
import { RubyExtractor } from '../../../src/sqi/extractors/ruby.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { initializeTreeSitter, parseCode, ensureLanguageGrammar, isLanguageReady } from '../../../src/parser/tree-sitter.js';

describe('RubyExtractor', () => {
  const extractor = new RubyExtractor();
  let rubyGrammarAvailable = false;

  beforeAll(async () => {
    await initializeTreeSitter();
    // Ruby is an optional grammar, try to load it
    rubyGrammarAvailable = await ensureLanguageGrammar('ruby');
  });

  // Helper to skip test if Ruby grammar is not available
  const itIfRuby = (name: string, fn: () => void | Promise<void>) => {
    it(name, async () => {
      if (!rubyGrammarAvailable) {
        console.log(`Skipping: ${name} (Ruby grammar not available)`);
        return;
      }
      await fn();
    });
  };

  describe('Symbol Extraction', () => {
    itIfRuby('should extract class definitions', () => {
      const code = `
# User model
class User
  def initialize(name)
    @name = name
  end

  def greet
    "Hello, #{@name}!"
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'user.rb', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'User');
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.symbol_kind).toBe(SymbolKind.CLASS);
      expect(classSymbol?.docstring?.description).toContain('User model');

      // Check children
      expect(classSymbol?.children).toBeDefined();
      expect(classSymbol?.children?.length).toBe(2);

      const initialize = classSymbol?.children?.find((c) => c.name === 'initialize');
      expect(initialize).toBeDefined();
      expect(initialize?.symbol_kind).toBe(SymbolKind.METHOD);
      expect(initialize?.parameters?.length).toBe(1);
      expect(initialize?.parameters?.[0]?.name).toBe('name');
    });

    itIfRuby('should extract module definitions', () => {
      const code = `
module Helpers
  def self.format_date(date)
    date.strftime("%Y-%m-%d")
  end

  def helper_method
    "helper"
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'helpers.rb', code);

      expect(result.success).toBe(true);

      const moduleSymbol = result.symbols.find((s) => s.name === 'Helpers');
      expect(moduleSymbol).toBeDefined();
      expect(moduleSymbol?.symbol_kind).toBe(SymbolKind.MODULE);

      // Check children
      expect(moduleSymbol?.children).toBeDefined();

      const formatDate = moduleSymbol?.children?.find((c) => c.name === 'format_date');
      expect(formatDate).toBeDefined();
      expect(formatDate?.is_static).toBe(true); // singleton_method
    });

    itIfRuby('should extract singleton (class) methods', () => {
      const code = `
class Factory
  def self.create(attrs)
    new(attrs)
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'factory.rb', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'Factory');
      expect(classSymbol).toBeDefined();

      const createMethod = classSymbol?.children?.find((c) => c.name === 'create');
      expect(createMethod).toBeDefined();
      expect(createMethod?.is_static).toBe(true);
    });

    itIfRuby('should extract attr_accessor definitions', () => {
      const code = `
class Person
  attr_reader :name
  attr_writer :email
  attr_accessor :age, :address
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'person.rb', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'Person');
      expect(classSymbol).toBeDefined();

      // Check attr_* properties
      const props = classSymbol?.children?.filter((c) => c.symbol_kind === SymbolKind.PROPERTY) ?? [];
      expect(props.length).toBeGreaterThanOrEqual(4);

      const nameAttr = props.find((p) => p.name === 'name');
      expect(nameAttr).toBeDefined();

      const ageAttr = props.find((p) => p.name === 'age');
      expect(ageAttr).toBeDefined();
    });

    itIfRuby('should extract constants', () => {
      const code = `
MAX_SIZE = 100
DEFAULT_NAME = "unnamed"

class Config
  VERSION = "1.0.0"
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'config.rb', code);

      expect(result.success).toBe(true);

      const maxSize = result.symbols.find((s) => s.name === 'MAX_SIZE');
      expect(maxSize).toBeDefined();
      expect(maxSize?.symbol_kind).toBe(SymbolKind.CONSTANT);

      const classSymbol = result.symbols.find((s) => s.name === 'Config');
      const version = classSymbol?.children?.find((c) => c.name === 'VERSION');
      expect(version).toBeDefined();
      expect(version?.symbol_kind).toBe(SymbolKind.CONSTANT);
    });

    itIfRuby('should handle various parameter types', () => {
      const code = `
class Example
  def complex_method(required, optional = nil, *args, keyword:, default_kw: "default", **kwargs, &block)
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'params.rb', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'Example');
      const method = classSymbol?.children?.find((c) => c.name === 'complex_method');
      expect(method).toBeDefined();
      expect(method?.parameters).toBeDefined();

      const params = method?.parameters ?? [];
      expect(params.length).toBeGreaterThan(0);

      const required = params.find((p) => p.name === 'required');
      expect(required).toBeDefined();
      expect(required?.is_optional).toBe(false);

      const optional = params.find((p) => p.name === 'optional');
      expect(optional?.is_optional).toBe(true);
    });

    itIfRuby('should handle visibility conventions', () => {
      const code = `
class Example
  def public_method
  end

  def _private_method
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'visibility.rb', code);

      expect(result.success).toBe(true);

      const classSymbol = result.symbols.find((s) => s.name === 'Example');

      const publicMethod = classSymbol?.children?.find((c) => c.name === 'public_method');
      expect(publicMethod?.visibility).toBe('public');

      const privateMethod = classSymbol?.children?.find((c) => c.name === '_private_method');
      expect(privateMethod?.visibility).toBe('private');
    });

    itIfRuby('should extract nested classes and modules', () => {
      const code = `
module Outer
  class Inner
    def inner_method
    end
  end
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'nested.rb', code);

      expect(result.success).toBe(true);

      const outerModule = result.symbols.find((s) => s.name === 'Outer');
      expect(outerModule).toBeDefined();

      const innerClass = outerModule?.children?.find((c) => c.name === 'Inner');
      expect(innerClass).toBeDefined();
      expect(innerClass?.symbol_kind).toBe(SymbolKind.CLASS);

      const innerMethod = innerClass?.children?.find((c) => c.name === 'inner_method');
      expect(innerMethod).toBeDefined();
    });
  });

  describe('Usage Extraction', () => {
    itIfRuby('should extract method calls', () => {
      const code = `
result = process_data(input)
UserService.create(attrs)
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'app.rb', code);

      expect(result.success).toBe(true);
      const calls = result.usages.filter((u) => u.usage_type === 'call');
      expect(calls.some((u) => u.symbol_name === 'process_data')).toBe(true);
    });

    itIfRuby('should extract class instantiation', () => {
      const code = `
user = User.new("John")
service = UserService.new(db)
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'app.rb', code);

      expect(result.success).toBe(true);
      const instantiations = result.usages.filter((u) => u.usage_type === 'instantiate');
      expect(instantiations.some((u) => u.symbol_name === 'User')).toBe(true);
    });

    itIfRuby('should extract class inheritance', () => {
      const code = `
class Admin < User
end

class CustomError < StandardError
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'classes.rb', code);

      expect(result.success).toBe(true);
      const extendsUsages = result.usages.filter((u) => u.usage_type === 'extend');
      expect(extendsUsages.some((u) => u.symbol_name === 'User')).toBe(true);
    });

    itIfRuby('should extract module includes', () => {
      const code = `
class MyClass
  include Comparable
  extend ClassMethods
  prepend Validation
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'mixins.rb', code);

      expect(result.success).toBe(true);
      const extendsUsages = result.usages.filter((u) => u.usage_type === 'extend');
      expect(extendsUsages.some((u) => u.symbol_name === 'Comparable')).toBe(true);
      expect(extendsUsages.some((u) => u.symbol_name === 'ClassMethods')).toBe(true);
    });

    itIfRuby('should not extract definition names as usages', () => {
      const code = `
def my_method
  42
end
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'test.rb', code);

      expect(result.success).toBe(true);
      // my_method should not be in usages since it's a definition
      const myMethodUsages = result.usages.filter((u) => u.symbol_name === 'my_method');
      expect(myMethodUsages).toHaveLength(0);
    });
  });

  describe('Import Extraction', () => {
    itIfRuby('should extract require statements', () => {
      const code = `
require 'json'
require 'net/http'
require 'active_record'
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'imports.rb', code);

      expect(result.success).toBe(true);
      expect(result.imports.length).toBeGreaterThanOrEqual(3);

      const jsonImport = result.imports.find((i) => i.module_specifier === 'json');
      expect(jsonImport).toBeDefined();
      expect(jsonImport?.import_type).toBe('require');
    });

    itIfRuby('should extract require_relative statements', () => {
      const code = `
require_relative 'lib/helpers'
require_relative '../models/user'
`;
      const tree = parseCode(code, 'ruby');
      const result = extractor.extract(tree, 'imports.rb', code);

      expect(result.success).toBe(true);

      const helperImport = result.imports.find((i) => i.module_specifier === 'lib/helpers');
      expect(helperImport).toBeDefined();
      expect(helperImport?.import_type).toBe('require_relative');
    });
  });
});
