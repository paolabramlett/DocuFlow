import { describe, expect, it } from 'vitest';
import {
  documentObjectPath,
  parseDocumentObjectPath,
  type DocumentObjectLocation,
} from '@/lib/storage/paths';

const location: DocumentObjectLocation = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  caseId: '22222222-2222-4222-8222-222222222222',
  requirementId: '33333333-3333-4333-8333-333333333333',
  documentId: '44444444-4444-4444-8444-444444444444',
};

describe('document object paths', () => {
  it('leads with the tenant so storage policies can authorize on folder 1', () => {
    expect(documentObjectPath(location).startsWith(`${location.organizationId}/`)).toBe(true);
  });

  it('places the case id at folder 3, where the storage policy reads it', () => {
    const folders = documentObjectPath(location).split('/');
    expect(folders[2]).toBe(location.caseId);
  });

  it('round-trips', () => {
    expect(parseDocumentObjectPath(documentObjectPath(location))).toEqual(location);
  });

  it('refuses to build a path from a non-UUID segment', () => {
    expect(() => documentObjectPath({ ...location, caseId: '../../etc/passwd' })).toThrow(
      /caseId is not a UUID/,
    );
  });

  it('fails closed on a malformed path rather than guessing', () => {
    expect(parseDocumentObjectPath('not/a/valid/path')).toBeNull();
    expect(parseDocumentObjectPath(`${location.organizationId}/files/x/y/z/w`)).toBeNull();
    expect(parseDocumentObjectPath('')).toBeNull();
  });
});
