import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RequirementView } from '@/features/cases/queries';
import { RequirementRow } from '@/app/cases/cases-workspace';
import { reopenRequirementAction } from '@/app/cases/actions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

// The component only reads whether these resolve, never their real behavior, for the assertions
// below (no button is clicked) — mocked so importing the component never loads the real Server
// Actions module (which pulls in Supabase env validation that only holds outside a real request).
vi.mock('@/app/cases/actions', () => ({
  getDocumentDownloadUrlAction: vi.fn(),
  reviewDocumentAction: vi.fn(),
  reopenRequirementAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
}));

const reviewableRequirement: RequirementView = {
  id: 'req-1',
  label: 'INE',
  state: 'review',
  documentId: 'doc-1',
  stageId: null,
  reopenedFromRequirementId: null,
};

const approvedRequirement: RequirementView = {
  id: 'req-2',
  label: 'Comprobante de domicilio',
  state: 'approved',
  documentId: 'doc-2',
  stageId: 'stage-1',
  reopenedFromRequirementId: null,
};

describe('RequirementRow — caseOpen gate (NOTE(#65): first coverage for this note)', () => {
  it('shows Aprobar/Rechazar/Ver documento when the Case is open and the Requirement is in review', () => {
    render(<RequirementRow r={reviewableRequirement} caseOpen={true} />);

    expect(screen.getByRole('button', { name: 'Aprobar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rechazar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver documento' })).toBeInTheDocument();
  });

  it('hides Aprobar/Rechazar when the Case is closed, even for a Requirement still "review"', () => {
    render(<RequirementRow r={reviewableRequirement} caseOpen={false} />);

    expect(screen.queryByRole('button', { name: 'Aprobar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rechazar' })).not.toBeInTheDocument();
    // The state label still renders — this only hides the action controls, not the row itself.
    expect(screen.getByText('En revisión')).toBeInTheDocument();
  });
});

describe('RequirementRow — Reabrir affordance (closes the missing-UI-entry-point gap)', () => {
  it('shows Reabrir for an approved requirement whose stage is completed, and confirming calls reopenRequirementAction with the id and reason', async () => {
    render(<RequirementRow r={approvedRequirement} caseOpen={true} stageCompleted={true} />);

    const reabrirButton = screen.getByRole('button', { name: 'Reabrir' });
    expect(reabrirButton).toBeInTheDocument();

    fireEvent.click(reabrirButton);

    const textarea = await screen.findByPlaceholderText('ej. El documento subido no coincide con el titular.');
    fireEvent.change(textarea, { target: { value: 'El documento no coincide con el titular.' } });

    const confirmButton = screen.getByRole('button', { name: 'Confirmar corrección' });
    fireEvent.click(confirmButton);

    await Promise.resolve();

    expect(reopenRequirementAction).toHaveBeenCalledWith('req-2', 'El documento no coincide con el titular.');
  });

  it('does not show Reabrir for an approved requirement whose stage is not yet completed', () => {
    render(<RequirementRow r={approvedRequirement} caseOpen={true} stageCompleted={false} />);

    expect(screen.queryByRole('button', { name: 'Reabrir' })).not.toBeInTheDocument();
  });
});
