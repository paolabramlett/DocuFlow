import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/app/portal/actions', () => ({
  uploadRequirementDocumentAction: vi.fn(),
  getClientDocumentUrlAction: vi.fn(),
  prepareUploadAction: vi.fn(),
  finalizeUploadAction: vi.fn(),
  cancelUploadSessionAction: vi.fn(),
}));

// Imported after the mocks above per this project's established component-test convention
// (see tests/component/stage-stepper.test.tsx).
import { Checklist } from '@/app/portal/[token]/portal-client';
import type { PortalState } from '@/application/client-portal';

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  return {
    organizationName: 'Notaría Test',
    caseTitle: 'Compraventa',
    caseState: 'open',
    requirements: [{ id: 'r1', label: 'INE', state: 'pending', reopenedFromRequirementId: null }],
    pendingCount: 1,
    isComplete: false,
    correctionsPending: [],
    workflowComplete: false,
    ...overrides,
  };
}

describe('RequirementCard — upload progress UI scaffold', () => {
  it('shows no progress bar before any file is selected', () => {
    render(<Checklist token="tok" state={baseState()} onChanged={() => {}} />);
    expect(screen.queryByText(/Subiendo…/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });
});
