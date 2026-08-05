import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workflowDocumentationComplete, type CaseView } from '@/features/cases/queries';

/** A minimal, otherwise-valid CaseView — only `stages` and `participants` matter to
 *  workflowDocumentationComplete's in-memory checks; the rest is filler to satisfy the type. */
function caseView(overrides: Partial<CaseView> & Pick<CaseView, 'stages' | 'participants'>): CaseView {
  return { id: randomUUID(), ref: 'CASE-TEST', title: 'Test', opened: '1 ene 2026', state: 'open', ...overrides };
}

describe('workflowDocumentationComplete', () => {
  it('returns true when every stage is completed and every requirement is approved', () => {
    const c = caseView({
      stages: [
        { id: 's1', name: 'Kick-Off', position: 0, status: 'completed', completionMode: 'requirements' },
        { id: 's2', name: 'Milestone 1', position: 1, status: 'completed', completionMode: 'requirements' },
      ],
      participants: [
        {
          id: 'p1', name: 'Comprador', role: 'Comprador',
          requirements: [
            { id: 'r1', label: 'INE', state: 'approved', stageId: 's1', reopenedFromRequirementId: null },
            { id: 'r2', label: 'Comprobante', state: 'approved', stageId: 's2', reopenedFromRequirementId: null },
          ],
        },
      ],
    });

    expect(workflowDocumentationComplete(c)).toBe(true);
  });

  it('returns false for a Requirement outstanding in an already-completed Stage — never reopened, never unassigned, just added directly', () => {
    const c = caseView({
      stages: [
        { id: 's1', name: 'Kick-Off', position: 0, status: 'completed', completionMode: 'requirements' },
      ],
      participants: [
        {
          id: 'p1', name: 'Comprador', role: 'Comprador',
          requirements: [
            // Added directly to a completed Stage, still outstanding — no reopenedFromRequirementId,
            // and stageId is non-null, so neither of the first two guards catches it.
            { id: 'r1', label: 'INE adicional', state: 'awaiting', stageId: 's1', reopenedFromRequirementId: null },
          ],
        },
      ],
    });

    expect(workflowDocumentationComplete(c)).toBe(false);
  });
});
