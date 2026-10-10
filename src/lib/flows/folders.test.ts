import { describe, expect, it } from 'vitest';

import { isUuid, normalizeFlowFolderName } from './folders';

describe('flow folder validation', () => {
  it('trims a valid name and rejects empty or oversized names', () => {
    expect(normalizeFlowFolderName('  Sales  ')).toBe('Sales');
    expect(normalizeFlowFolderName('   ')).toBeNull();
    expect(normalizeFlowFolderName('a'.repeat(81))).toBeNull();
  });

  it('accepts only UUIDs for resource references', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('folder-a')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
