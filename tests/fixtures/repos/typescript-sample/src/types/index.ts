/**
 * Common type definitions
 */

export type ID = string;

export type Timestamp = Date;

export interface Entity {
  id: ID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type AsyncResult<T, E = Error> = Promise<{ ok: true; value: T } | { ok: false; error: E }>;

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;
