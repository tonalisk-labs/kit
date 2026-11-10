// Only the JSON-LD blocks that parse: the basics report the others.
import { isObject, type JsonObject } from '../unknown.ts';
import type { Page } from './build.ts';
import { factsOf } from './html.ts';

/** One value is a list of one; none is an empty list. */
export const listOf = (value: unknown): readonly unknown[] => {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items;
  }
  return [value];
};

export const blocksOf = (page: Page): unknown[] =>
  factsOf(page.parsed).data.flatMap((text) => {
    try {
      const parsed: unknown = JSON.parse(text);
      return [parsed];
    } catch {
      return [];
    }
  });

/** Each block's `@graph`, or the block itself. */
export const pageNodes = (page: Page): JsonObject[] =>
  blocksOf(page).flatMap((block) =>
    listOf(isObject(block) ? block['@graph'] : block).filter((node) => isObject(node)),
  );

export const typesOf = (node: JsonObject): string[] =>
  listOf(node['@type']).filter((type) => typeof type === 'string');

/** Every object in a value, itself included, depth first. */
export const objectsIn = (value: unknown): JsonObject[] => {
  if (isObject(value)) {
    return [value, ...Object.values(value).flatMap((child) => objectsIn(child))];
  }
  return Array.isArray(value) ? listOf(value).flatMap((child) => objectsIn(child)) : [];
};

/** `{ "@id": … }` alone references a node; an `@id` beside other properties defines one. */
export const idOf = (node: JsonObject, defining: boolean): string | undefined => {
  const id = node['@id'];
  const defines = Object.keys(node).length > 1;
  return typeof id === 'string' && defines === defining ? id : undefined;
};

export const textAt = (node: JsonObject, key: string): string | undefined => {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
};
