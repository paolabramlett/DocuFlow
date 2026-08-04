import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CaseView } from '@/features/cases/queries';
import { ClosureBanner } from '@/app/cases/cases-workspace';
import { reopenCaseAction } from '@/app/cases/actions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/cases/actions', () => ({
  reopenCaseAction: vi.fn(),
}));

const closedCase: CaseView = {
  id: 'case-1',
  ref: 'CASE-TEST',
  title: 'Test',
  opened: '1 ene 2026',
  state: 'completed',
  participants: [],
  stages: [],
};

describe('ClosureBanner — reopen() branching on requiresReinvitation/notificationFailureCount (NOTE(#65))', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports requiresReinvitation when reopening restored no grants', async () => {
    vi.mocked(reopenCaseAction).mockResolvedValue({
      ok: true,
      data: { requiresReinvitation: true, notificationFailureCount: 0 },
    });
    const onReopened = vi.fn();
    const user = userEvent.setup();
    render(<ClosureBanner c={closedCase} onReopened={onReopened} />);

    await user.click(screen.getByRole('button', { name: 'Reabrir expediente' }));

    await waitFor(() =>
      expect(onReopened).toHaveBeenLastCalledWith(
        'El cliente ya no tiene un enlace activo — usa Recordar para invitarlo de nuevo.',
      ),
    );
  });

  it('reports a partial notification failure with the exact count from the Server Action', async () => {
    vi.mocked(reopenCaseAction).mockResolvedValue({
      ok: true,
      data: { requiresReinvitation: false, notificationFailureCount: 2 },
    });
    const onReopened = vi.fn();
    const user = userEvent.setup();
    render(<ClosureBanner c={closedCase} onReopened={onReopened} />);

    await user.click(screen.getByRole('button', { name: 'Reabrir expediente' }));

    await waitFor(() =>
      expect(onReopened).toHaveBeenLastCalledWith(
        'Se restauró el acceso, pero no pudimos notificar a 2 participantes — usa Recordar.',
      ),
    );
  });

  it('reports no message at all when reopening fully succeeds', async () => {
    vi.mocked(reopenCaseAction).mockResolvedValue({
      ok: true,
      data: { requiresReinvitation: false, notificationFailureCount: 0 },
    });
    const onReopened = vi.fn();
    const user = userEvent.setup();
    render(<ClosureBanner c={closedCase} onReopened={onReopened} />);

    await user.click(screen.getByRole('button', { name: 'Reabrir expediente' }));

    await waitFor(() => expect(onReopened).toHaveBeenLastCalledWith(null));
  });

  it('shows the failure message locally, never routing it through onReopened, when the action itself fails', async () => {
    vi.mocked(reopenCaseAction).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'Este expediente no está cerrado.',
    });
    const onReopened = vi.fn();
    const user = userEvent.setup();
    render(<ClosureBanner c={closedCase} onReopened={onReopened} />);

    await user.click(screen.getByRole('button', { name: 'Reabrir expediente' }));

    await screen.findByText('Este expediente no está cerrado.');
    // onReopened(null) is called once at the start of every attempt (to clear a stale message);
    // it must never be called a second time with the failure text — that display stays local.
    expect(onReopened).toHaveBeenCalledTimes(1);
    expect(onReopened).toHaveBeenCalledWith(null);
  });
});
