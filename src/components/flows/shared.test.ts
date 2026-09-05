import { describe, expect, it } from 'vitest';

import {
  NODE_CATEGORIES,
  NODE_META,
  groupNodeTypesByCategory,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';

const ALL_TYPES = Object.keys(NODE_META) as NodeType[];

describe('node categories', () => {
  it('assigns every node type to a known category', () => {
    const known = new Set(NODE_CATEGORIES.map((c) => c.id));
    for (const type of ALL_TYPES) {
      expect(known.has(NODE_META[type].category)).toBe(true);
    }
  });
});

describe('groupNodeTypesByCategory', () => {
  it('keeps the categories in NODE_CATEGORIES order and drops empty ones', () => {
    // Only messaging + flow types — the logic group must not appear.
    const groups = groupNodeTypesByCategory(['send_message', 'start', 'end']);
    expect(groups.map((g) => g.id)).toEqual(['messaging', 'flow']);
  });

  it('preserves the input order within a category', () => {
    const groups = groupNodeTypesByCategory([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
  });

  it('partitions the full type list without losing or duplicating a type', () => {
    const grouped = groupNodeTypesByCategory(ALL_TYPES).flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe('summarizeNode — delay / set_contact_field', () => {
  it('summarizes a delay node with its seconds', () => {
    const node: BuilderNode = {
      node_key: 'd',
      node_type: 'delay',
      config: { seconds: 10, next_node_key: 'x' },
    };
    expect(summarizeNode(node)).toBe('Wait 10s');
  });

  it('returns null for a delay node with no seconds configured yet', () => {
    const node: BuilderNode = { node_key: 'd', node_type: 'delay', config: {} };
    expect(summarizeNode(node)).toBeNull();
  });

  it('summarizes a set_contact_field node as field = value', () => {
    const node: BuilderNode = {
      node_key: 'scf',
      node_type: 'set_contact_field',
      config: { field: 'custom:abc12345', value: '177', next_node_key: 'x' },
    };
    expect(summarizeNode(node)).toBe('abc12345 = 177');
  });

  it('flags an empty value distinctly from no field picked', () => {
    const withField: BuilderNode = {
      node_key: 'scf',
      node_type: 'set_contact_field',
      config: { field: 'custom:abc', value: '', next_node_key: 'x' },
    };
    expect(summarizeNode(withField)).toBe('abc = (empty)');

    const noField: BuilderNode = {
      node_key: 'scf',
      node_type: 'set_contact_field',
      config: {},
    };
    expect(summarizeNode(noField)).toBeNull();
  });
});
