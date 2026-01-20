# SQI Test Case Schema

Test cases for the Structural Query Index (SQI) symbol extraction.

## YAML Structure

```yaml
# Test suite metadata
name: "TypeScript Basic Extraction"
language: typescript
description: "Tests basic symbol extraction for TypeScript"

# Test cases
cases:
  - name: "function declaration"
    code: |
      function hello(name: string): string {
        return `Hello, ${name}!`;
      }
    
    # Expected symbols (list)
    expect:
      symbols:
        - name: hello
          kind: function
          is_exported: false
          return_type: string
          parameters:
            - name: name
              type: string

  - name: "exported class with methods"
    code: |
      export class UserService {
        private db: Database;
        
        constructor(db: Database) {
          this.db = db;
        }
        
        async getUser(id: string): Promise<User> {
          return this.db.find(id);
        }
      }
    
    expect:
      symbols:
        - name: UserService
          kind: class
          is_exported: true
          children:
            - name: db
              kind: property
            - name: constructor
              kind: constructor
            - name: getUser
              kind: method
              is_async: true
```

## Symbol Kinds

Valid values for `kind`:
- `function`
- `class`
- `method`
- `property`
- `constructor`
- `interface`
- `type_alias`
- `enum`
- `enum_member`
- `variable`
- `constant`
- `module`
- `namespace`
- `mixin`
- `trait`

## Matching Rules

1. **Partial matching**: Only specified fields are checked
2. **Symbol order**: Symbols can appear in any order
3. **Children**: Nested symbols are matched recursively
4. **Optional fields**: Omitted fields are not validated

## Usage Examples

### Checking only symbol names exist
```yaml
expect:
  symbols:
    - name: MyClass
    - name: myFunction
```

### Checking specific properties
```yaml
expect:
  symbols:
    - name: fetchData
      kind: function
      is_async: true
      is_exported: true
```

### Checking usages (imports/references)
```yaml
expect:
  usages:
    - symbol: Database
      kind: import
    - symbol: User
      kind: type_reference
```
