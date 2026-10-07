import fs from 'node:fs';
import path from 'node:path';
import { EventDocument } from '../domain/types';
import { logger } from '../logger';

export interface ProviderRule {
  eventId?: string;
  tenantId?: string;
  sourceId?: string;
  responses: number[];
}

export interface ProviderPlan {
  defaultStatus?: number;
  rules?: ProviderRule[];
  events?: Record<string, number[]>;
}

export interface VerificationResult {
  status: number;
  error?: string;
  isRetryable: boolean;
  isPermanent: boolean;
}

export class ExternalVerificationProvider {
  private plan: ProviderPlan;

  constructor(planOrPath?: ProviderPlan | string) {
    if (typeof planOrPath === 'string') {
      this.plan = this.loadPlanFromFile(planOrPath);
    } else if (planOrPath && typeof planOrPath === 'object') {
      this.plan = planOrPath;
    } else {
      this.plan = this.loadDefaultPlan();
    }
  }

  private loadDefaultPlan(): ProviderPlan {
    const defaultPath = path.resolve(process.cwd(), 'fixtures/provider-plan.json');
    if (fs.existsSync(defaultPath)) {
      return this.loadPlanFromFile(defaultPath);
    }
    return { defaultStatus: 200, rules: [] };
  }

  private loadPlanFromFile(filePath: string): ProviderPlan {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
      if (fs.existsSync(resolved)) {
        const raw = fs.readFileSync(resolved, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.warn({ err, filePath }, 'Failed to read provider plan file');
    }
    return { defaultStatus: 200, rules: [] };
  }

  /**
   * Runs the external verification step for a given event and attempt number.
   * Attempt is 1-indexed (1, 2, 3...).
   */
  async verify(event: EventDocument, attempt: number): Promise<VerificationResult> {
    const defaultStatus = this.plan.defaultStatus ?? 200;
    let responses: number[] | undefined;

    // 1. Check rules list
    if (this.plan.rules && Array.isArray(this.plan.rules)) {
      const matched = this.plan.rules.find((r) => {
        if (r.eventId && r.eventId !== event.eventId) return false;
        if (r.tenantId && r.tenantId !== event.tenantId) return false;
        if (r.sourceId && r.sourceId !== event.sourceId) return false;
        return true;
      });
      if (matched) {
        responses = matched.responses;
      }
    }

    // 2. Check map if not found in rules
    if (!responses && this.plan.events && this.plan.events[event.eventId]) {
      responses = this.plan.events[event.eventId];
    }

    let status = defaultStatus;
    if (responses && responses.length > 0) {
      const idx = Math.min(attempt - 1, responses.length - 1);
      status = responses[idx] ?? defaultStatus;
    }

    const isRetryable = status === 429 || status === 503;
    const isPermanent = status === 422;

    let error: string | undefined;
    if (status >= 400) {
      error = `Provider verification returned HTTP ${status}`;
    }

    return {
      status,
      error,
      isRetryable,
      isPermanent,
    };
  }
}
