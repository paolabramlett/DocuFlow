import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CaseView } from '@/features/cases/queries';
import { CasesWorkspace } from '@/app/cases/cases-workspace';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/cases/actions', () => ({
  advanceCaseStageAction: vi.fn(),
  assignRequirementStageAction: vi.fn(),
  closeCaseAction: vi.fn(),
  reopenCaseAction: vi.fn(),
  reviewDocumentAction: vi.fn(),
  sendManualReminderAction: vi.fn(),
  getDocumentDownloadUrlAction: vi.fn(),
}));

function stagedCase(overrides: Partial<CaseView> = {}): CaseView {
  return {
    id: 'case-1', ref: 'CASE-TEST', title: 'Con etapas', opened: '1 ene 2026', state: 'open',
    stages: [
      { id: 'stage-1', name: 'Kick-Off', position: 0, status: 'active', completionMode: 'requirements' },
      { id: 'stage-2', name: 'Milestone 1', position: 1, status: 'locked', completionMode: 'requirements' },
    ],
    participants: [
      {
        id: 'p1', name: 'Comprador', role: 'Comprador',
        requirements: [
          { id: 'r1', label: 'INE', state: 'approved', stageId: 'stage-1', reopenedFromRequirementId: null },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Stage stepper — Continuar button gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables Continuar when the active stage is fully approved', () => {
    render(<CasesWorkspace cases={[stagedCase()]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);
    expect(screen.getByRole('button', { name: 'Continuar a Milestone 1' })).toBeEnabled();
  });

  it('disables Continuar with a specific reason when the active stage has an outstanding requirement', () => {
    const c = stagedCase({
      participants: [
        { id: 'p1', name: 'Comprador', role: 'Comprador', requirements: [{ id: 'r1', label: 'INE', state: 'awaiting', stageId: 'stage-1', reopenedFromRequirementId: null }] },
      ],
    });
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);
    expect(screen.getByRole('button', { name: 'Continuar a Milestone 1' })).toBeDisabled();
    expect(screen.getByText(/Faltan 1 requisito/)).toBeInTheDocument();
  });

  it('shows no stage stepper controls for a Case with no workflow', () => {
    const c = stagedCase({ stages: [] });
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);
    expect(screen.getByText('Sin workflow por etapas')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continuar a/ })).not.toBeInTheDocument();
  });
});
