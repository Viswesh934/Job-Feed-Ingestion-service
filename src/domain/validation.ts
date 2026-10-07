import { z } from 'zod';
import { IngestionEventInput, NormalizedJobPayload } from './types.js';

/**
 * Validates that an identifier string is nonblank and has no leading or trailing whitespace.
 */
function isValidIdentifier(val: string): boolean {
  if (typeof val !== 'string') return false;
  if (val.trim().length === 0) return false;
  return val === val.trim();
}

const identifierSchema = z.string()
  .refine(isValidIdentifier, {
    message: 'Identifier must be nonblank and have no surrounding whitespace',
  });

/**
 * Validates that a string is nonblank after trimming.
 */
function isNonBlankAfterTrim(val: string): boolean {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Normalizes an array of skills:
 * - Trims each string
 * - Converts to lowercase
 * - Removes duplicates while preserving the first occurrence order
 */
export function normalizeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const s of skills) {
    const trimmedLower = s.trim().toLowerCase();
    if (!seen.has(trimmedLower)) {
      seen.add(trimmedLower);
      normalized.push(trimmedLower);
    }
  }
  return normalized;
}

const rawPayloadSchema = z.object({
  title: z.string().refine(isNonBlankAfterTrim, {
    message: 'Title must be nonblank after trimming',
  }),
  company: z.string().refine(isNonBlankAfterTrim, {
    message: 'Company must be nonblank after trimming',
  }),
  location: z.string().refine(isNonBlankAfterTrim, {
    message: 'Location must be nonblank after trimming',
  }),
  experienceMin: z.number().int({ message: 'experienceMin must be an integer' })
    .min(0, { message: 'experienceMin must be >= 0' })
    .max(50, { message: 'experienceMin must be <= 50' }),
  experienceMax: z.number().int({ message: 'experienceMax must be an integer' })
    .min(0, { message: 'experienceMax must be >= 0' })
    .max(50, { message: 'experienceMax must be <= 50' }),
  applyUrl: z.string().refine((urlStr) => {
    try {
      const parsed = new URL(urlStr);
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, {
    message: 'applyUrl must be a valid HTTPS URL',
  }),
  skills: z.array(
    z.string().refine(isNonBlankAfterTrim, {
      message: 'Skill item must be a nonblank string',
    })
  ),
}).refine((data) => data.experienceMin <= data.experienceMax, {
  message: 'experienceMin must not be greater than experienceMax',
  path: ['experienceMin'],
});

export const ingestionEventSchema = z.object({
  tenantId: identifierSchema,
  sourceId: identifierSchema,
  eventId: identifierSchema,
  externalJobId: identifierSchema,
  version: z.number()
    .int({ message: 'Version must be an integer' })
    .positive({ message: 'Version must be positive' })
    .refine((v) => Number.isSafeInteger(v), {
      message: 'Version must be a safe integer',
    }),
  operation: z.enum(['upsert', 'archive']),
  payload: z.unknown().optional(),
}).superRefine((data, ctx) => {
  if (data.operation === 'upsert') {
    if (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Payload is required for upsert operation',
        path: ['payload'],
      });
      return;
    }
    const result = rawPayloadSchema.safeParse(data.payload);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['payload', ...issue.path],
        });
      }
    }
  } else if (data.operation === 'archive') {
    if (data.payload !== undefined && data.payload !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Payload must be omitted for archive operation',
        path: ['payload'],
      });
    }
  }
});

export interface ValidationSuccess {
  success: true;
  data: IngestionEventInput & {
    normalizedPayload?: NormalizedJobPayload;
  };
}

export interface ValidationFailure {
  success: false;
  errors: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validates and normalizes an incoming event request.
 */
export function validateAndNormalizeEvent(raw: unknown): ValidationResult {
  const parseResult = ingestionEventSchema.safeParse(raw);
  if (!parseResult.success) {
    return {
      success: false,
      errors: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const data = parseResult.data as IngestionEventInput;
  let normalizedPayload: NormalizedJobPayload | undefined;

  if (data.operation === 'upsert' && data.payload) {
    normalizedPayload = {
      title: data.payload.title.trim(),
      company: data.payload.company.trim(),
      location: data.payload.location.trim(),
      experienceMin: data.payload.experienceMin,
      experienceMax: data.payload.experienceMax,
      applyUrl: data.payload.applyUrl.trim(),
      skills: normalizeSkills(data.payload.skills),
    };
  }

  return {
    success: true,
    data: {
      ...data,
      normalizedPayload,
    },
  };
}
