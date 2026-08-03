import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  addStaffMember,
  adminClient,
  anonClient,
  createOrganizationWithOwner,
  type DocuFlowClient,
  type TestUser,
} from './clients';
import type { Database } from '@/types/database';

type Industry = Database['public']['Tables']['organizations']['Row']['industry'];
type Permission = Database['public']['Tables']['case_access_grants']['Row']['permission'];

export interface OrganizationWorld {
  readonly organizationId: string;
  readonly owner: TestUser;
  readonly staff: TestUser;
  readonly clientId: string;
  readonly clientEmail: string;
  readonly blueprintId: string;
  readonly caseId: string;
  /** The Case's primary Participant; the cloned Requirements are assigned to it. */
  readonly participantId: string;
  readonly requirementIds: readonly string[];
}

export interface ParticipantHandle {
  readonly participantId: string;
  readonly clientId: string;
  readonly clientEmail: string;
}

/**
 * Adds a Participant to a Case: creates its Client, the Participant row, and returns handles.
 * Used to build multi-party Cases for the intra-Case isolation tests.
 */
export async function addParticipant(
  world: OrganizationWorld,
  options: { roleLabel: string; clientEmail: string; fullName?: string },
): Promise<ParticipantHandle> {
  const { data: client, error: clientError } = await world.staff.client
    .from('clients')
    .insert({
      organization_id: world.organizationId,
      full_name: options.fullName ?? 'Second Party',
      email: options.clientEmail,
    })
    .select('id')
    .single();
  if (clientError || !client) throw new Error(`fixture: client: ${clientError?.message}`);

  const { data: participant, error: participantError } = await world.staff.client
    .from('case_participants')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      client_id: client.id,
      role_label: options.roleLabel,
    })
    .select('id')
    .single();
  if (participantError || !participant) {
    throw new Error(`fixture: participant: ${participantError?.message}`);
  }

  return {
    participantId: participant.id,
    clientId: client.id,
    clientEmail: options.clientEmail,
  };
}

const BLUEPRINT_DEFINITIONS = [
  { key: 'identity-document', type: 'document', label: 'Identity document', instructions: 'Passport or national ID' },
  { key: 'proof-of-address', type: 'document', label: 'Proof of address', instructions: 'Utility bill under 3 months' },
  { key: 'signed-mandate', type: 'document', label: 'Signed mandate' },
];

/**
 * Builds one Organization with a full Case: owner, staff, client, blueprint, cloned case, and
 * its requirements.
 *
 * `clientEmail` is a parameter so two worlds can deliberately share one, which is how the suite
 * proves that the same person in two Organizations produces two independent records.
 */
export async function buildOrganizationWorld(options: {
  name: string;
  industry: Industry;
  clientEmail: string;
}): Promise<OrganizationWorld> {
  const { organizationId, owner } = await createOrganizationWithOwner(
    options.name,
    options.industry,
  );
  const staff = await addStaffMember(owner, organizationId);

  const { data: client, error: clientError } = await owner.client
    .from('clients')
    .insert({
      organization_id: organizationId,
      full_name: 'Test Client',
      email: options.clientEmail,
    })
    .select('id')
    .single();

  if (clientError || !client) {
    throw new Error(`fixture: could not create client: ${clientError?.message}`);
  }

  const { data: blueprint, error: blueprintError } = await owner.client
    .from('blueprints')
    .insert({
      organization_id: organizationId,
      name: 'Standard intake',
      requirement_definitions: BLUEPRINT_DEFINITIONS,
    })
    .select('id')
    .single();

  if (blueprintError || !blueprint) {
    throw new Error(`fixture: could not create blueprint: ${blueprintError?.message}`);
  }

  const { data: caseId, error: caseError } = await staff.client.rpc('create_case', {
    target_organization_id: organizationId,
    target_client_id: client.id,
    case_title: 'Property transfer',
    from_blueprint_id: blueprint.id,
  });

  if (caseError || !caseId) {
    throw new Error(`fixture: could not create case: ${caseError?.message}`);
  }

  // A Case needs at least one Participant to be actionable. Create the primary Participant and
  // assign the cloned Requirements to it, so a granted Client can see them.
  const { data: participant, error: participantError } = await staff.client
    .from('case_participants')
    .insert({
      organization_id: organizationId,
      case_id: caseId,
      client_id: client.id,
      role_label: 'primary',
    })
    .select('id')
    .single();
  if (participantError || !participant) {
    throw new Error(`fixture: could not create participant: ${participantError?.message}`);
  }

  const { error: assignError } = await staff.client
    .from('requirements')
    .update({ participant_id: participant.id })
    .eq('case_id', caseId);
  if (assignError) {
    throw new Error(`fixture: could not assign requirements: ${assignError.message}`);
  }

  const { data: requirements, error: requirementsError } = await staff.client
    .from('requirements')
    .select('id')
    .eq('case_id', caseId)
    .order('position');

  if (requirementsError || !requirements) {
    throw new Error(`fixture: could not read requirements: ${requirementsError?.message}`);
  }

  return {
    organizationId,
    owner,
    staff,
    clientId: client.id,
    clientEmail: options.clientEmail,
    blueprintId: blueprint.id,
    caseId,
    participantId: participant.id,
    requirementIds: requirements.map((row) => row.id),
  };
}

export interface TwoOrganizationWorld {
  readonly a: OrganizationWorld;
  readonly b: OrganizationWorld;
  /** The same human, served by both Organizations. */
  readonly sharedClientEmail: string;
}

export async function buildTwoOrganizationWorld(): Promise<TwoOrganizationWorld> {
  const sharedClientEmail = `shared-${randomUUID()}@example.test`;

  const a = await buildOrganizationWorld({
    name: 'Notaría A',
    industry: 'notary',
    clientEmail: sharedClientEmail,
  });
  const b = await buildOrganizationWorld({
    name: 'Contaduría B',
    industry: 'accounting',
    clientEmail: sharedClientEmail,
  });

  return { a, b, sharedClientEmail };
}

/** Paginated lookup, since the admin API offers no direct get-by-email. */
async function findAuthUserIdByEmail(
  admin: DocuFlowClient,
  email: string,
): Promise<string | undefined> {
  const perPage = 200;

  for (let page = 1; page <= 25; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`fixture: could not list users: ${error.message}`);

    const match = data.users.find((user) => user.email === email);
    if (match) return match.id;
    if (data.users.length < perPage) return undefined;
  }

  return undefined;
}

export interface GrantedClient {
  readonly grantId: string;
  readonly participantId: string;
  readonly authUserId: string;
  /** Authenticated as the Client, carrying only what the grant allows. */
  readonly client: DocuFlowClient;
}

/**
 * Issues a grant and marks it verified, standing in for the OTP exchange.
 *
 * Uses the service role because it is fixture construction, not an assertion. Every test that
 * checks what the grant permits then runs through `client`, which is an ordinary authenticated
 * connection subject to RLS.
 */
export async function grantVerifiedAccess(options: {
  world: OrganizationWorld;
  permission?: Permission;
  expiresAt?: Date;
  /** Backdate activation to test cadence boundaries against a seeded clock. */
  verifiedAt?: Date;
  /** Grant against a specific Participant; defaults to the world's primary Participant. */
  participantId?: string;
  /** The Participant's Client, for binding the identity; defaults to the primary Client. */
  clientId?: string;
  /** Reuse an identity so one human can hold grants in several Organizations. */
  existingAuthUserId?: string;
  existingEmail?: string;
  /**
   * A plaintext token for the caller to keep and use later (e.g. against getClientDocumentUrl,
   * which resolves the grant by token, not by session identity alone). Normal callers never need
   * this — the real flow's token exists only in an email — but a test that needs to act "as this
   * already-verified Client" via a Server Action-style call needs a token it actually holds.
   * Defaults to a random one that's immediately discarded, exactly like the real flow's first
   * invitation ever does.
   */
  token?: string;
}): Promise<GrantedClient> {
  const admin = adminClient();
  const email = options.existingEmail ?? options.world.clientEmail;
  const participantId = options.participantId ?? options.world.participantId;
  const clientId = options.clientId ?? options.world.clientId;
  const password = randomUUID();

  // Create or reuse, mirroring what verification does in the real flow: one verified email maps
  // to one identity, however many Organizations invite it (client-identity spec).
  let authUserId = options.existingAuthUserId ?? (await findAuthUserIdByEmail(admin, email));

  if (!authUserId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`fixture: could not create client identity: ${error?.message}`);
    }
    authUserId = data.user.id;
  } else {
    const { error } = await admin.auth.admin.updateUserById(authUserId, { password });
    if (error) {
      throw new Error(`fixture: could not set password: ${error.message}`);
    }
  }

  const expiresAt = options.expiresAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const verifiedAt = options.verifiedAt ?? new Date();

  const { data: grant, error: grantError } = await admin
    .from('case_access_grants')
    .insert({
      organization_id: options.world.organizationId,
      case_id: options.world.caseId,
      participant_id: participantId,
      invited_email: email,
      invitation_token_hash: createHash('sha256')
        .update(options.token ?? randomBytes(32).toString('hex'))
        .digest('hex'),
      permission: options.permission ?? 'upload',
      auth_user_id: authUserId,
      verified_at: verifiedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single();

  if (grantError || !grant) {
    throw new Error(`fixture: could not create grant: ${grantError?.message}`);
  }

  await admin.from('clients').update({ auth_user_id: authUserId }).eq('id', clientId);

  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`fixture: could not sign in client: ${signInError.message}`);
  }

  return { grantId: grant.id, participantId, authUserId, client };
}
