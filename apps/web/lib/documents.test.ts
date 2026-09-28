import { describe, it, expect } from 'vitest';
import { canDownloadDocument, scanStatusLabel } from './documents';

describe('document scan status helpers', () => {
  it('labels scan lifecycle values', () => {
    expect(scanStatusLabel('pending')).toBe('Scanning');
    expect(scanStatusLabel('clean')).toBe('Clean');
    expect(scanStatusLabel('blocked')).toBe('Blocked');
    expect(scanStatusLabel('bogus')).toBe('bogus');
    expect(scanStatusLabel(null)).toBe('—');
  });

  it('only clean documents are downloadable', () => {
    expect(canDownloadDocument('clean')).toBe(true);
    expect(canDownloadDocument('pending')).toBe(false);
    expect(canDownloadDocument('blocked')).toBe(false);
    expect(canDownloadDocument(null)).toBe(false);
  });
});