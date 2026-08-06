import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/app/portal/actions', () => ({
  getClientDocumentUrlAction: vi.fn(),
  prepareUploadAction: vi.fn(),
  finalizeUploadAction: vi.fn(),
  cancelUploadSessionAction: vi.fn(),
}));

vi.mock('@/lib/upload/direct-upload', () => ({ uploadFileDirectly: vi.fn() }));

// Imported after the mocks above per this project's established component-test convention
// (see tests/component/stage-stepper.test.tsx).
import { Checklist } from '@/app/portal/[token]/portal-client';
import type { PortalState } from '@/application/client-portal';
import { prepareUploadAction, finalizeUploadAction, cancelUploadSessionAction } from '@/app/portal/actions';
import { uploadFileDirectly } from '@/lib/upload/direct-upload';
import userEvent from '@testing-library/user-event';

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

describe('RequirementCard — full upload pipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows progress during upload, then Confirmando during finalize, then clears on success', async () => {
    vi.mocked(prepareUploadAction).mockResolvedValue({
      ok: true,
      data: { sessionId: 's1', signedUrl: 'http://x', token: 't1', path: 'p1' },
    });
    let resolveUpload!: () => void;
    vi.mocked(uploadFileDirectly).mockImplementation(
      (input) =>
        new Promise((resolve) => {
          resolveUpload = () => {
            input.onProgress(42);
            resolve();
          };
        }),
    );
    // Deliberately deferred, not mockResolvedValue: an immediately-resolved finalizeUploadAction
    // lets React 18's automatic batching collapse the uploading -> finalizing -> idle transitions
    // into a single commit within the same microtask flush (confirmed empirically — with
    // mockResolvedValue here, "Confirmando…" never actually paints and this test times out).
    // Holding finalizeUploadAction open the same way uploadFileDirectly already is above forces a
    // real, separately-observable "finalizing" render, matching how a genuine network round trip
    // behaves.
    let resolveFinalize!: () => void;
    vi.mocked(finalizeUploadAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinalize = () => resolve({ ok: true, data: { documentId: 'd1' } });
        }),
    );

    render(<Checklist token="tok" state={baseState()} onChanged={vi.fn()} />);
    const user = userEvent.setup();
    const file = new File(['x'], 'ine.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]')!;
    await user.upload(input as HTMLInputElement, file);

    resolveUpload();
    await screen.findByText('Confirmando…');

    resolveFinalize();
    await waitFor(() => expect(screen.queryByText('Confirmando…')).not.toBeInTheDocument());
  });

  it('cancels the upload and calls cancelUploadSessionAction', async () => {
    vi.mocked(prepareUploadAction).mockResolvedValue({
      ok: true,
      data: { sessionId: 's1', signedUrl: 'http://x', token: 't1', path: 'p1' },
    });
    vi.mocked(uploadFileDirectly).mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        }),
    );
    vi.mocked(cancelUploadSessionAction).mockResolvedValue({ ok: true, data: null });

    render(<Checklist token="tok" state={baseState()} onChanged={vi.fn()} />);
    const user = userEvent.setup();
    const file = new File(['x'], 'ine.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]')!;
    await user.upload(input as HTMLInputElement, file);

    await screen.findByRole('button', { name: 'Cancelar' });
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(cancelUploadSessionAction).toHaveBeenCalledWith('s1');
  });
});
