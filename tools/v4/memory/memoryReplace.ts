/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryReplace.ts — `memory_replace` wrapper.
 *
 * Substring-matched replace across MEMORY.md, USER.md, or PROJECT.md.
 * Returns `verified: true` only after the post-write read confirms
 * the new text is present and the old text is absent.
 *
 * v4.10 Slice 10.1 — `project` joins the file enum. See memoryAdd.ts
 * header for the rationale + non-throw guarantee on unresolvable
 * project root.
 *
 * Status: PHASE 9 + v4.10 Slice 10.1.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { truncatePreview } from '../../../core/v4/dryRun';
import { normalizeMemoryFile, fileLabel } from './namespaceNormalize';
import { isMemorySource, type MemorySource } from '../../../core/v4/memory/provenance';
import { createHash } from 'node:crypto';

/** Model-supplied source, defaulting to the honest lower-trust `guess`. A
 *  lower-trust source cannot overwrite a higher-trust entry (enforced below). */
function pickSource(raw: unknown): MemorySource {
  return isMemorySource(raw) ? raw : 'guess';
}

function learningScopeKind(file: 'memory' | 'user' | 'project') {
  return file === 'user' ? 'USER_GLOBAL' : file === 'project' ? 'REPOSITORY' : 'WORKSPACE';
}

export const memoryReplaceTool: ToolHandler = {
  schema: {
    name: 'memory_replace',
    description:
      'Replace one entry in MEMORY.md, USER.md, or PROJECT.md with new text. Substring match — fails if old_text is ambiguous. Returns verified=true only after the change is confirmed on disk. A lower-trust source cannot overwrite a higher-trust entry (said > saw > guess).',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user', 'project'],
          description: 'Which file to modify. `project` writes to <projectRoot>/.aiden/PROJECT.md and only works when Aiden detects a project root.',
        },
        old_text: { type: 'string', description: 'Substring of the entry to replace.' },
        new_text: { type: 'string', description: 'Replacement entry.' },
        source: {
          type: 'string',
          enum: ['said', 'saw', 'guess'],
          description:
            "Where the new text came from: 'said' = user stated it; 'saw' = tool evidence; 'guess' = inferred. Defaults to 'guess'. A lower-trust source is refused when the existing entry is higher-trust.",
        },
      },
      required: ['file', 'old_text', 'new_text'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const file = normalizeMemoryFile(args.file);
    const oldText = String(args.old_text ?? args.oldText ?? '');
    const newText = String(args.new_text ?? args.newText ?? '');
    return {
      tool: 'memory_replace',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'memory_write', op: 'replace', pattern: truncatePreview(oldText, 80), bullet: truncatePreview(newText, 80) }],
      detectedRisks: [],
      summary: `Would replace in ${fileLabel(file)}: "${truncatePreview(oldText, 40)}" → "${truncatePreview(newText, 40)}"`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    const file = normalizeMemoryFile(args.file);
    const oldText = String(args.old_text ?? args.oldText ?? '');
    const newText = String(args.new_text ?? args.newText ?? '');
    const source = pickSource(args.source);
    try {
      const r = await ctx.memoryGuard.guardedReplace(file, oldText, newText, source);
      if (r.ok && r.verified && source === 'said' && ctx.learning) {
        const scopeKind = learningScopeKind(file);
        const scope = ctx.learning.scopes.find((candidate) => candidate.kind === scopeKind);
        if (!scope) {
          return {
            success: false,
            verified: false,
            error: `Learning scope ${scopeKind} is unavailable`,
            file,
            fileLength: r.fileLength,
          };
        }
        const type = file === 'user' ? 'USER_PREFERENCE' : 'WORKSPACE_CONVENTION';
        const correctionDigest = createHash('sha256')
          .update([file, oldText.trim(), newText.trim()].join('\0'))
          .digest('hex');
        const correctionSource = {
          kind: 'USER_CORRECTION' as const,
          identity: `memory_replace:${file}:${correctionDigest}`,
          revision: correctionDigest,
          independentKey: `user:${scope.ownerId}`,
          metadata: { namespace: file, provenance: 'said', provenanceVerified: true },
        };
        try {
          const entries = ctx.learning.authority.list({ scopes: [scope] });
          const matches = entries
            .filter((entry) => entry.type === type
              && entry.lifecycle !== 'DELETED'
              && entry.content?.includes(oldText))
            .sort((left, right) => {
              const leftExplicit = left.subjectKey.startsWith(`explicit.${file}.`) ? 1 : 0;
              const rightExplicit = right.subjectKey.startsWith(`explicit.${file}.`) ? 1 : 0;
              return rightExplicit - leftExplicit || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
            });
          let winner = matches[0];
          if (winner) {
            winner = ctx.learning.authority.correct({
              entryId: winner.id,
              expectedVersion: winner.version,
              content: newText,
              source: correctionSource,
            });
            for (const duplicate of matches.slice(1)) {
              const current = ctx.learning.authority.get(duplicate.id);
              if (current && current.lifecycle !== 'DEMOTED' && current.lifecycle !== 'DELETED') {
                ctx.learning.authority.demote({
                  entryId: current.id,
                  expectedVersion: current.version,
                  reason: 'duplicate_superseded_by_explicit_user_correction',
                  source: correctionSource,
                });
              }
            }
          } else {
            const sameContent = entries.find((entry) => entry.type === type
              && entry.lifecycle !== 'DELETED'
              && entry.content === newText);
            if (sameContent) {
              ctx.learning.authority.correct({
                entryId: sameContent.id,
                expectedVersion: sameContent.version,
                content: newText,
                source: correctionSource,
              });
            } else {
              const contentDigest = createHash('sha256').update(newText.trim()).digest('hex');
              ctx.learning.authority.capture({
                scope,
                type,
                subjectKey: `explicit.${file}.${contentDigest.slice(0, 32)}`,
                content: newText,
                source: correctionSource,
              });
            }
          }
        } catch (error) {
          return {
            success: false,
            verified: false,
            error: `Learning correction failed: ${error instanceof Error ? error.message : String(error)}`,
            file,
            fileLength: r.fileLength,
          };
        }
      }
      return {
        success: r.ok,
        verified: r.verified,
        error: r.ok ? undefined : r.reason,
        file,
        fileLength: r.fileLength,
      };
    } catch (e) {
      // Synthetic failure for unresolvable namespaces — see memoryAdd
      // for the design rationale (project without projectRoot).
      return {
        success: false,
        verified: false,
        error: (e as Error).message,
        file,
      };
    }
  },
};
