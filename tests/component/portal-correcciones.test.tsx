import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Checklist } from '@/app/portal/[token]/portal-client';
import type { PortalState } from '@/application/client-portal';

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  return {
    organizationName: 'Notaría Test',
    caseTitle: 'Compraventa',
    caseState: 'open',
    requirements: [],
    pendingCount: 0,
    isComplete: true,
    correctionsPending: [],
    workflowComplete: false,
    ...overrides,
  };
}

describe('Portal Checklist — Correcciones pendientes section', () => {
  it('renders a dedicated section, separate from the active-stage list, for a reopened requirement', () => {
    const state = baseState({
      correctionsPending: [
        { id: 'r1', label: 'INE comprador', state: 'pending', stageStatus: 'completed', originalStageName: 'Kick-Off', reopenedFromRequirementId: 'orig-1' },
      ],
    });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    expect(screen.getByText('Correcciones pendientes')).toBeInTheDocument();
    expect(screen.getByText('INE comprador')).toBeInTheDocument();
    expect(screen.getByText('(Kick-Off)')).toBeInTheDocument();
  });

  it('shows nothing when there are no pending corrections', () => {
    render(<Checklist token="tok" state={baseState()} onChanged={() => {}} />);
    expect(screen.queryByText('Correcciones pendientes')).not.toBeInTheDocument();
  });

  it('shows the workflow-complete message, distinct from the terminal-state banner, when the Case is still open', () => {
    const state = baseState({ workflowComplete: true, caseState: 'open' });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    expect(screen.getByText('Workflow completo')).toBeInTheDocument();
    expect(screen.getByText(/El equipo continuará con el proceso/)).toBeInTheDocument();
    expect(screen.queryByText(/expediente completado/i)).not.toBeInTheDocument();
  });

  it('a reopened requirement is excluded from the ordinary "Qué necesitas hacer" pending list', () => {
    const state = baseState({
      pendingCount: 2,
      isComplete: false,
      requirements: [
        { id: 'r2', label: 'CURP vendedor', state: 'pending', reopenedFromRequirementId: null },
        { id: 'r1', label: 'INE comprador', state: 'pending', stageStatus: 'completed', originalStageName: 'Kick-Off', reopenedFromRequirementId: 'orig-1' },
      ],
      correctionsPending: [
        { id: 'r1', label: 'INE comprador', state: 'pending', stageStatus: 'completed', originalStageName: 'Kick-Off', reopenedFromRequirementId: 'orig-1' },
      ],
    });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    // "INE comprador" appears once, inside Correcciones pendientes — not duplicated into the
    // ordinary pending list below it.
    expect(screen.getAllByText('INE comprador')).toHaveLength(1);
    expect(screen.getByText('CURP vendedor')).toBeInTheDocument();
  });
});
