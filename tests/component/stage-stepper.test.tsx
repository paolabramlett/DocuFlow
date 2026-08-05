import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CaseView } from '@/features/cases/queries';
import { CasesWorkspace } from '@/app/cases/cases-workspace';
import { advanceCaseStageAction, assignRequirementStageAction } from '@/app/cases/actions';

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

  it('shows no stage stepper controls for a Case with no workflow — renders nothing, not a placeholder label', () => {
    const c = stagedCase({ stages: [] });
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);
    expect(screen.queryByText('Sin workflow por etapas')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continuar a/ })).not.toBeInTheDocument();
  });

  it('clicking Continuar calls advanceCaseStageAction with the exact case id', async () => {
    vi.mocked(advanceCaseStageAction).mockResolvedValue({ ok: true, data: { notifiedParticipantIds: [] } });
    const user = userEvent.setup();
    render(<CasesWorkspace cases={[stagedCase()]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);

    await user.click(screen.getByRole('button', { name: 'Continuar a Milestone 1' }));

    expect(advanceCaseStageAction).toHaveBeenCalledWith('case-1');
  });

  it('renders the RPC failure message when advanceCaseStageAction rejects even though the client-side blocker was clear', async () => {
    vi.mocked(advanceCaseStageAction).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'La etapa actual todavía tiene requisitos pendientes.',
    });
    const user = userEvent.setup();
    render(<CasesWorkspace cases={[stagedCase()]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);

    await user.click(screen.getByRole('button', { name: 'Continuar a Milestone 1' }));

    await screen.findByText('La etapa actual todavía tiene requisitos pendientes.');
  });
});

function caseWithUnassignedRequirement(): CaseView {
  return {
    id: 'case-2', ref: 'CASE-TEST-2', title: 'Con requisito sin etapa', opened: '1 ene 2026', state: 'open',
    stages: [
      { id: 'stage-1', name: 'Kick-Off', position: 0, status: 'active', completionMode: 'requirements' },
    ],
    participants: [
      {
        id: 'p1', name: 'Comprador', role: 'Comprador',
        requirements: [
          { id: 'r2', label: 'Comprobante de domicilio', state: 'awaiting', stageId: null, reopenedFromRequirementId: null },
        ],
      },
    ],
  };
}

describe('SinEtapaSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the Sin etapa heading and the unassigned requirement, and Asignar calls assignRequirementStageAction with the requirement and active stage ids', async () => {
    vi.mocked(assignRequirementStageAction).mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();
    const c = caseWithUnassignedRequirement();
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);

    expect(screen.getByText('Sin etapa')).toBeInTheDocument();
    // Renders both inside the Sin etapa list and (unchanged) inside the participant's own
    // requirement list — the requirement's stageId being null only adds a row, it doesn't move one.
    expect(screen.getAllByText('Comprobante de domicilio').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Asignar a etapa activa' }));

    expect(assignRequirementStageAction).toHaveBeenCalledWith('r2', 'stage-1');
  });

  it('shows the failure message from assignRequirementStageAction on the page, proving errors are no longer swallowed', async () => {
    vi.mocked(assignRequirementStageAction).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'Solo se puede asignar a la etapa activa.',
    });
    const user = userEvent.setup();
    const c = caseWithUnassignedRequirement();
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ name: 'A', sub: 'a@b.com' }} />);

    await user.click(screen.getByRole('button', { name: 'Asignar a etapa activa' }));

    await screen.findByText('Solo se puede asignar a la etapa activa.');
  });
});
