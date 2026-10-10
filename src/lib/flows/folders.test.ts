import { describe, expect, it } from 'vitest';

import {
  isIntegrityViolation,
  isUuid,
  normalizeFlowFolderName,
} from './folders';

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

  it('classifies only database integrity errors as conflicts', () => {
    expect(isIntegrityViolation({ code: '23503' })).toBe(true);
    expect(isIntegrityViolation({ code: '23505' })).toBe(true);
    expect(isIntegrityViolation({ code: '08006' })).toBe(false);
    expect(isIntegrityViolation({ code: 'XX000' })).toBe(false);
  });
});
