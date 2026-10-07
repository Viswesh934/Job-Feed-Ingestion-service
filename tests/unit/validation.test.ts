import { describe, it, expect } from 'vitest';
import { validateAndNormalizeEvent, normalizeSkills } from '../../src/domain/validation';

describe('Event Validation and Normalization', () => {
  const validUpsert = {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'event-101',
    externalJobId: 'alpha',
    version: 1,
    operation: 'upsert',
    payload: {
      title: 'Full Stack Developer',
      company: 'Example Labs',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 3,
      applyUrl: 'https://example.test/jobs/alpha',
      skills: [' TypeScript ', 'MongoDB', 'typescript'],
    },
  };

  it('validates a correct upsert event and normalizes display strings and skills', () => {
    const result = validateAndNormalizeEvent(validUpsert);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.normalizedPayload?.title).toBe('Full Stack Developer');
      expect(result.data.normalizedPayload?.skills).toEqual(['typescript', 'mongodb']);
    }
  });

  it('validates a correct archive event without payload', () => {
    const validArchive = {
      tenantId: 'tenant-a',
      sourceId: 'main',
      eventId: 'event-102',
      externalJobId: 'alpha',
      version: 2,
      operation: 'archive',
    };
    const result = validateAndNormalizeEvent(validArchive);
    expect(result.success).toBe(true);
  });

  it('rejects archive event if payload is provided', () => {
    const invalidArchive = {
      tenantId: 'tenant-a',
      sourceId: 'main',
      eventId: 'event-102',
      externalJobId: 'alpha',
      version: 2,
      operation: 'archive',
      payload: { title: 'Some title' },
    };
    const result = validateAndNormalizeEvent(invalidArchive);
    expect(result.success).toBe(false);
  });

  describe('Identifier whitespace rejection', () => {
    it('rejects leading whitespace in tenantId', () => {
      const result = validateAndNormalizeEvent({ ...validUpsert, tenantId: ' tenant-a' });
      expect(result.success).toBe(false);
    });

    it('rejects trailing whitespace in externalJobId', () => {
      const result = validateAndNormalizeEvent({ ...validUpsert, externalJobId: 'alpha ' });
      expect(result.success).toBe(false);
    });

    it('rejects blank identifier', () => {
      const result = validateAndNormalizeEvent({ ...validUpsert, eventId: '   ' });
      expect(result.success).toBe(false);
    });
  });

  describe('Version validation', () => {
    it('rejects version 0 or negative', () => {
      expect(validateAndNormalizeEvent({ ...validUpsert, version: 0 }).success).toBe(false);
      expect(validateAndNormalizeEvent({ ...validUpsert, version: -1 }).success).toBe(false);
    });

    it('rejects float version', () => {
      expect(validateAndNormalizeEvent({ ...validUpsert, version: 1.5 }).success).toBe(false);
    });

    it('rejects unsafe integer', () => {
      expect(validateAndNormalizeEvent({ ...validUpsert, version: Number.MAX_SAFE_INTEGER + 10 }).success).toBe(false);
    });
  });

  describe('Payload field validation', () => {
    it('rejects non-https URLs', () => {
      const invalid = {
        ...validUpsert,
        payload: {
          ...validUpsert.payload,
          applyUrl: 'http://example.test/jobs/alpha',
        },
      };
      expect(validateAndNormalizeEvent(invalid).success).toBe(false);
    });

    it('rejects experienceMin greater than experienceMax', () => {
      const invalid = {
        ...validUpsert,
        payload: {
          ...validUpsert.payload,
          experienceMin: 5,
          experienceMax: 2,
        },
      };
      expect(validateAndNormalizeEvent(invalid).success).toBe(false);
    });

    it('rejects experience out of 0..50 range', () => {
      const invalid = {
        ...validUpsert,
        payload: {
          ...validUpsert.payload,
          experienceMax: 55,
        },
      };
      expect(validateAndNormalizeEvent(invalid).success).toBe(false);
    });

    it('rejects blank title after trimming', () => {
      const invalid = {
        ...validUpsert,
        payload: {
          ...validUpsert.payload,
          title: '   ',
        },
      };
      expect(validateAndNormalizeEvent(invalid).success).toBe(false);
    });

    it('rejects blank skill strings', () => {
      const invalid = {
        ...validUpsert,
        payload: {
          ...validUpsert.payload,
          skills: ['TypeScript', '   '],
        },
      };
      expect(validateAndNormalizeEvent(invalid).success).toBe(false);
    });
  });

  describe('Skill normalization', () => {
    it('deduplicates and preserves first occurrence order', () => {
      const skills = [' Node.js ', 'React', 'node.js', 'react', 'TYPESCRIPT'];
      expect(normalizeSkills(skills)).toEqual(['node.js', 'react', 'typescript']);
    });
  });
});
