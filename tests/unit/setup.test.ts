import { describe, it, expect } from 'vitest';

describe('Project Setup', () => {
  it('should have working test infrastructure', () => {
    expect(true).toBe(true);
  });

  it('should support basic assertions', () => {
    const value = 42;
    expect(value).toBe(42);
    expect(value).toBeGreaterThan(0);
  });
});
