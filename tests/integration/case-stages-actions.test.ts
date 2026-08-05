import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import * as authContextModule from '@/features/auth/context';
import * as supabaseServerModule from '@/lib/supabase/server';
import * as nextCacheModule from 'next/cache';
import type { FailureReason } from '@/application/errors';
import {
  advanceCaseStageAction,
  reopenRequirementAction,
  assignRequirementStageAction,
} from '@/app/cases/actions';
// Deliberately NOT mocked — this file exercises the real advance_case_stage / reopen_requirement /
// assign_requirement_stage RPC-error mappers in src/features/cases/cases.ts (mapAdvanceStageError,
// mapReopenRequirementError, mapAssignStageError), which otherwise have zero test execution anywhere
// in the repo. Only auth, the Supabase server client, and next/cache are mocked — same pattern as
// tests/integration/reopen-case-action.test.ts.
import { advanceCaseStage, reopenRequirement, assignRequirementStage } from '@/features/cases/cases';

vi.mock('@/features/auth/context');
vi.mock('@/lib/supabase/server');
vi.mock('next/cache');

type DbClient = SupabaseClient<Database>;

/** A fake Supabase client whose only implemented member is `.rpc`, matching exactly what every
 *  function under test in src/features/cases/cases.ts actually calls. */
function mockRpcClient(
  rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>,
): DbClient {
  return { rpc: vi.fn(rpcImpl) } as unknown as DbClient;
}

const staffContext = {
  organizationId: randomUUID(),
  role: 'staff' as const,
  userId: randomUUID(),
  email: 'staff@example.test',
  organizationName: 'Test Org',
  organizationIndustry: 'notary' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('advanceCaseStageAction', () => {
  it('returns unauthenticated when getStaffContext returns null', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(null);

    const result = await advanceCaseStageAction(randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthenticated');
  });

  it('forwards notifiedParticipantIds and notificationFailureCount verbatim and revalidates /cases on success', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(staffContext);
    const rpcClient = mockRpcClient(async () => ({ data: [{ participant_id: 'participant-1' }], error: null }));
    // notifyParticipantsOfStageAdvance now resolves activeGrantParticipants via `.from`, which this
    // fake never populates with any active grant — so `participant-1` (never granted anything in
    // this fixture-free test) is skipped rather than emailed, keeping notificationFailureCount at 0
    // without needing to also fake reissueParticipantInvitation/sendTransactionalEmail here.
    const client = {
      ...rpcClient,
      // Thenable so `await ....eq(...)` (activeGrantParticipants' case_access_grants query) works,
      // while also exposing `.single()` for readCaseAndOrgName's cases query — one fake shape
      // covering both `.from(...)` call sites this action's real notify path now makes.
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
              resolve({ data: [], error: null }),
            single: vi.fn().mockResolvedValue({ data: { title: 'Test', organization: { name: 'Test Org' } }, error: null }),
          }),
        }),
      }),
    } as unknown as DbClient;
    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(client);
    vi.spyOn(nextCacheModule, 'revalidatePath').mockImplementation(() => {});

    const result = await advanceCaseStageAction(randomUUID());

    expect(result).toEqual({
      ok: true,
      data: { notifiedParticipantIds: ['participant-1'], notificationFailureCount: 0 },
    });
    expect(nextCacheModule.revalidatePath).toHaveBeenCalledWith('/cases');
  });
});

describe('reopenRequirementAction', () => {
  it('returns unauthenticated when getStaffContext returns null', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(null);

    const result = await reopenRequirementAction(randomUUID(), 'Falta la firma.');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthenticated');
  });

  it('forwards the use case result verbatim and revalidates /cases on success', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(staffContext);
    const client = mockRpcClient(async () => ({ data: randomUUID(), error: null }));
    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(client);
    vi.spyOn(nextCacheModule, 'revalidatePath').mockImplementation(() => {});

    const result = await reopenRequirementAction(randomUUID(), 'Falta la firma.');

    expect(result).toEqual({ ok: true, data: null });
    expect(nextCacheModule.revalidatePath).toHaveBeenCalledWith('/cases');
  });
});

describe('assignRequirementStageAction', () => {
  it('returns unauthenticated when getStaffContext returns null', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(null);

    const result = await assignRequirementStageAction(randomUUID(), randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthenticated');
  });

  it('forwards null on success and revalidates /cases', async () => {
    vi.spyOn(authContextModule, 'getStaffContext').mockResolvedValue(staffContext);
    const client = mockRpcClient(async () => ({ data: null, error: null }));
    vi.spyOn(supabaseServerModule, 'createClient').mockResolvedValue(client);
    vi.spyOn(nextCacheModule, 'revalidatePath').mockImplementation(() => {});

    const result = await assignRequirementStageAction(randomUUID(), randomUUID());

    expect(result).toEqual({ ok: true, data: null });
    expect(nextCacheModule.revalidatePath).toHaveBeenCalledWith('/cases');
  });
});

/**
 * Table-driven coverage for every message key in ADVANCE_STAGE_MESSAGES, REOPEN_REQUIREMENT_MESSAGES,
 * and ASSIGN_STAGE_MESSAGES (src/features/cases/cases.ts) — 18 keys across 3 error maps that
 * previously had zero test execution anywhere in the repo. Each row drives the REAL, unmocked
 * advanceCaseStage / reopenRequirement / assignRequirementStage function (not the Server Action) by
 * feeding the key back as the mocked RPC's `error.message`, proving the private mapAdvanceStageError /
 * mapReopenRequirementError / mapAssignStageError functions produce the exact reason + Spanish
 * message pair for every key, plus the correct fallback for an unrecognized message.
 */
interface ErrorCase {
  readonly rpcMessage: string;
  readonly reason: FailureReason;
  readonly message: string;
}

const advanceStageCases: ErrorCase[] = [
  { rpcMessage: 'case_not_found', reason: 'not_found', message: 'El expediente ya no existe.' },
  { rpcMessage: 'not_authorized', reason: 'forbidden', message: 'No tienes permiso para avanzar este expediente.' },
  { rpcMessage: 'no_active_stage', reason: 'conflict', message: 'Este expediente no tiene una etapa activa.' },
  {
    rpcMessage: 'unassigned_requirement_pending',
    reason: 'conflict',
    message: 'Hay requisitos sin etapa asignada. Resuélvelos primero.',
  },
  {
    rpcMessage: 'reopened_requirement_pending',
    reason: 'conflict',
    message: 'Hay una corrección pendiente de una etapa anterior.',
  },
  { rpcMessage: 'stage_not_ready', reason: 'conflict', message: 'La etapa actual todavía tiene requisitos pendientes.' },
  {
    rpcMessage: 'some_unrecognized_rpc_message',
    reason: 'unexpected',
    message: 'No pudimos avanzar el expediente. Intenta de nuevo.',
  },
];

const reopenRequirementCases: ErrorCase[] = [
  { rpcMessage: 'requirement_not_found', reason: 'not_found', message: 'Ese requisito ya no existe.' },
  { rpcMessage: 'not_authorized', reason: 'forbidden', message: 'No tienes permiso para reabrir este requisito.' },
  {
    rpcMessage: 'requirement_has_no_stage',
    reason: 'conflict',
    message: 'Este requisito no pertenece a ninguna etapa.',
  },
  {
    rpcMessage: 'stage_not_completed',
    reason: 'conflict',
    message: 'Solo se pueden reabrir requisitos de una etapa ya completada.',
  },
  { rpcMessage: 'requirement_not_satisfied', reason: 'conflict', message: 'Este requisito no está aprobado.' },
  { rpcMessage: 'reopen_reason_required', reason: 'validation', message: 'Escribe el motivo de la corrección.' },
  {
    rpcMessage: 'some_unrecognized_rpc_message',
    reason: 'unexpected',
    message: 'No pudimos reabrir el requisito. Intenta de nuevo.',
  },
];

const assignStageCases: ErrorCase[] = [
  { rpcMessage: 'requirement_not_found', reason: 'not_found', message: 'Ese requisito ya no existe.' },
  { rpcMessage: 'not_authorized', reason: 'forbidden', message: 'No tienes permiso para asignar este requisito.' },
  {
    rpcMessage: 'requirement_already_assigned',
    reason: 'conflict',
    message: 'Este requisito ya tiene una etapa asignada.',
  },
  {
    rpcMessage: 'reopened_requirement_cannot_move',
    reason: 'conflict',
    message: 'No se puede reasignar un requisito reabierto.',
  },
  { rpcMessage: 'stage_not_found', reason: 'not_found', message: 'Esa etapa no existe en este expediente.' },
  { rpcMessage: 'stage_not_active', reason: 'conflict', message: 'Solo se puede asignar a la etapa activa.' },
  {
    rpcMessage: 'some_unrecognized_rpc_message',
    reason: 'unexpected',
    message: 'No pudimos asignar el requisito. Intenta de nuevo.',
  },
];

describe('advanceCaseStage RPC error mapping (mapAdvanceStageError)', () => {
  for (const { rpcMessage, reason, message } of advanceStageCases) {
    it(`maps "${rpcMessage}" to reason="${reason}"`, async () => {
      const client = mockRpcClient(async () => ({ data: null, error: { message: rpcMessage } }));

      await expect(advanceCaseStage(client, randomUUID())).rejects.toMatchObject({ reason, message });
    });
  }
});

describe('reopenRequirement RPC error mapping (mapReopenRequirementError)', () => {
  for (const { rpcMessage, reason, message } of reopenRequirementCases) {
    it(`maps "${rpcMessage}" to reason="${reason}"`, async () => {
      const client = mockRpcClient(async () => ({ data: null, error: { message: rpcMessage } }));

      await expect(reopenRequirement(client, randomUUID(), 'Falta la firma.')).rejects.toMatchObject({
        reason,
        message,
      });
    });
  }
});

describe('assignRequirementStage RPC error mapping (mapAssignStageError)', () => {
  for (const { rpcMessage, reason, message } of assignStageCases) {
    it(`maps "${rpcMessage}" to reason="${reason}"`, async () => {
      const client = mockRpcClient(async () => ({ data: null, error: { message: rpcMessage } }));

      await expect(assignRequirementStage(client, randomUUID(), randomUUID())).rejects.toMatchObject({
        reason,
        message,
      });
    });
  }
});
