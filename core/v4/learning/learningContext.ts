/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { LearningAuthority } from './learningAuthority';
import { createHash } from 'node:crypto';
import { currentJobExecutionContext } from '../daemon/jobExecutionContext';
import type { LearningRetrievalResult, LearningScope, LearningType } from './types';

export interface LearningContextRequest {
  objective: string;
  scopes: LearningScope[];
  maxEntries?: number;
  maxChars?: number;
  types?: LearningType[];
}

/** One provider-neutral read port. Callers never query Learning tables directly. */
export interface LearningContextProvider {
  retrieveLearning(input: LearningContextRequest): Promise<LearningRetrievalResult> | LearningRetrievalResult;
}

/** Persist references, never learned plaintext, in the existing scoped Job history. */
export function recordLearningSelection(result: LearningRetrievalResult): void {
  const execution = currentJobExecutionContext();
  if (!execution) return;
  const entries = result.items.slice(0, 8).map(item => ({ entryId: item.id, version: item.version }));
  const identity = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const recorded = execution.engine.appendJobEvent({ jobId: execution.jobId, attemptId: execution.attemptId,
    generation: execution.generation, type: 'learning.context_selected', payload: { entries },
    producer: execution.producer, idempotencyKey: `learning-context:${execution.attemptId}:${execution.generation}:${identity}` });
  if (!recorded.applied && !recorded.duplicate) throw new Error('Context selection belongs to a stale execution');
}

export function createLearningContextProvider(authority: LearningAuthority): LearningContextProvider {
  return {
    retrieveLearning(input) {
      return authority.retrieve({
        query: input.objective,
        scopes: input.scopes,
        limit: input.maxEntries,
        maxChars: input.maxChars,
        types: input.types,
      });
    },
  };
}
