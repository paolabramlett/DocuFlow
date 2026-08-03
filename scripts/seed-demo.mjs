#!/usr/bin/env node
/**
 * Seeds the local database with demo data so the UI has real content to read through RLS.
 *
 * Uses the service role to write directly (RLS-bypassing) — this is fixture construction, not app
 * behaviour, exactly like the test fixtures. Idempotent: it recreates the demo organization from
 * scratch each run.
 *
 * Creates a staff login (staff@docuflow.mx) and the three cases the UI already showed, now backed
 * by real rows: Compraventa · Restrepo (buyer + seller, mixed states), Testamento · Villa, and a
 * completed Poder notarial · Guzmán. Run after `npm run db:reset`.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";

config({ path: ".env.local", quiet: true });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing env. Run: npm run db:start && npm run db:env");
  process.exit(1);
}

const STAFF_EMAIL = "staff@docuflow.mx";
const STAFF_PASSWORD = "docuflow-demo-2026";
/** Must match CASE_DOCUMENTS_BUCKET in src/lib/storage/paths.ts. */
const CASE_DOCUMENTS_BUCKET = "case-documents";
/** Placeholder bytes so createSignedUrl() has a real object to sign — Ver/Descargar fail on a
 *  documents row whose storage_path was never actually uploaded. */
const PLACEHOLDER_PDF_BYTES = Buffer.from("%PDF-1.4 seed placeholder document");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const must = (label, error) => {
  if (error) {
    console.error(`${label}: ${error.message}`);
    process.exit(1);
  }
};

async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    must("listUsers", error);
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureStaffUser() {
  const existing = await findUserByEmail(STAFF_EMAIL);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password: STAFF_PASSWORD });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: STAFF_EMAIL,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  must("createUser(staff)", error);
  return data.user.id;
}

async function insert(table, row, select = "id") {
  const { data, error } = await admin.from(table).insert(row).select(select).single();
  must(`insert ${table}`, error);
  return data;
}

async function main() {
  const staffId = await ensureStaffUser();

  // Fresh start: drop any demo orgs this staff already owns (cascades to all their data).
  const { data: myOrgs } = await admin.from("members").select("organization_id").eq("user_id", staffId);
  for (const m of myOrgs ?? []) {
    await admin.from("organizations").delete().eq("id", m.organization_id);
  }

  const org = await insert("organizations", { name: "Notaría Central", industry: "notary" });
  await insert("members", { organization_id: org.id, user_id: staffId, role: "owner" }, "id");

  // Helper to create a blueprint with participant templates and requirement definitions.
  async function createBlueprint({ name, description, requirementDefinitions, participantTemplates = [], stages = [] }) {
    const blueprint = await insert("blueprints", {
      organization_id: org.id,
      name,
      description: description ?? null,
      requirement_definitions: requirementDefinitions,
      is_platform_template: true,
    });

    for (const t of participantTemplates) {
      await insert("blueprint_participant_templates", {
        organization_id: org.id,
        blueprint_id: blueprint.id,
        role_key: t.roleKey,
        display_name: t.displayName,
        position: t.position,
      });
    }

    for (const s of stages) {
      await insert("blueprint_stages", {
        organization_id: org.id,
        blueprint_id: blueprint.id,
        name: s.name,
        position: s.position,
      });
    }

    return blueprint;
  }

  // Blueprints — real rows for the Create Case wizard and Plantillas to read. Four shapes,
  // deliberately covering multi-role, single-role, and role-less Blueprints, plus a deliberate
  // cross-bucket key reuse (buyer/official-id and seller/official-id) proving bucket-scoped
  // uniqueness works in practice, not just in theory.
  await createBlueprint({
    name: "Compraventa",
    description: "Venta de un inmueble entre un comprador y un vendedor.",
    requirementDefinitions: [
      { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "buyer" },
      { key: "curp", type: "document", label: "CURP", scope: "participant", participant_role_key: "buyer" },
      { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "seller" },
      { key: "curp", type: "document", label: "CURP", scope: "participant", participant_role_key: "seller" },
      { key: "property-title", type: "document", label: "Título de propiedad", scope: "participant", participant_role_key: "seller" },
      { key: "appraisal", type: "document", label: "Avalúo", scope: "case" },
    ],
    participantTemplates: [
      { roleKey: "buyer", displayName: "Comprador", position: 0 },
      { roleKey: "seller", displayName: "Vendedor", position: 1 },
    ],
  });

  await createBlueprint({
    name: "Testamento",
    description: "Testamento otorgado por un solo testador.",
    requirementDefinitions: [
      { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "testator" },
      { key: "asset-inventory", type: "document", label: "Inventario de bienes", scope: "participant", participant_role_key: "testator" },
      { key: "witness-data", type: "document", label: "Datos de testigos", scope: "participant", participant_role_key: "testator" },
    ],
    participantTemplates: [
      { roleKey: "testator", displayName: "Testador", position: 0 },
    ],
  });

  await createBlueprint({
    name: "Constitución de sociedad",
    description: "Constitución con socios fundadores.",
    requirementDefinitions: [
      { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "founding-partner" },
      { key: "capital-contribution", type: "document", label: "Aportación de capital", scope: "participant", participant_role_key: "founding-partner" },
      { key: "bylaws", type: "document", label: "Estatutos sociales", scope: "case" },
    ],
    participantTemplates: [
      { roleKey: "founding-partner", displayName: "Socio fundador", position: 0 },
    ],
  });

  await createBlueprint({
    name: "Poder notarial",
    description: "Poder otorgado por una persona.",
    requirementDefinitions: [
      { key: "official-id", type: "document", label: "INE", scope: "case" },
      { key: "attorney-data", type: "document", label: "Datos del apoderado", scope: "case" },
      { key: "signed-authorization", type: "document", label: "Autorización firmada", scope: "case" },
    ],
    // Deliberately no participantTemplates — proves the "role-less Blueprint" path works.
  });

  // Clients (org-owned records).
  const paola = await insert("clients", { organization_id: org.id, full_name: "Paola Restrepo", email: "paola.restrepo@example.mx" });
  const mateo = await insert("clients", { organization_id: org.id, full_name: "Mateo Restrepo", email: "mateo.restrepo@example.mx" });
  const ana = await insert("clients", { organization_id: org.id, full_name: "Ana Villa", email: "ana.villa@example.mx" });
  const luis = await insert("clients", { organization_id: org.id, full_name: "Luis Guzmán", email: "luis.guzman@example.mx" });

  // Helper to create a case with participants and their requirements + document/review states.
  async function createCase({ title, primaryClientId, participants, state = "open" }) {
    const c = await insert("cases", {
      organization_id: org.id,
      client_id: primaryClientId,
      title,
      state,
      completed_at: state === "completed" ? new Date().toISOString() : null,
    });

    const createdParticipants = [];
    for (const p of participants) {
      const part = await insert("case_participants", {
        organization_id: org.id,
        case_id: c.id,
        client_id: p.clientId,
        role_label: p.role,
      });
      createdParticipants.push({ participantId: part.id, clientId: p.clientId, role: p.role });

      let position = 0;
      for (const r of p.requirements) {
        const req = await insert("requirements", {
          organization_id: org.id,
          case_id: c.id,
          participant_id: part.id,
          type: "document",
          label: r.label,
          position: position++,
          status: r.state === "approved" ? "satisfied" : "outstanding",
        });

        // Give review/rejected states a document, and rejected ones a review with a reason.
        if (r.state === "review" || r.state === "rejected" || r.state === "approved") {
          const storagePath = `${org.id}/cases/${c.id}/requirements/${req.id}/${crypto.randomUUID()}`;
          const { error: uploadError } = await admin.storage
            .from(CASE_DOCUMENTS_BUCKET)
            .upload(storagePath, PLACEHOLDER_PDF_BYTES, { contentType: "application/pdf" });
          must(`upload document (${r.label})`, uploadError);

          const doc = await insert("documents", {
            organization_id: org.id,
            case_id: c.id,
            requirement_id: req.id,
            storage_path: storagePath,
            file_name: r.fileName ?? "documento.pdf",
            content_type: "application/pdf",
            size_bytes: PLACEHOLDER_PDF_BYTES.byteLength,
          });
          if (r.state === "rejected") {
            await insert("reviews", {
              organization_id: org.id,
              case_id: c.id,
              document_id: doc.id,
              decision: "rejected",
              reason: r.reason ?? "El documento está incompleto.",
            }, "id");
          } else if (r.state === "approved") {
            await insert("reviews", {
              organization_id: org.id,
              case_id: c.id,
              document_id: doc.id,
              decision: "approved",
            }, "id");
          }
        }
      }
    }
    return { ...c, participants: createdParticipants };
  }

  /** Mirrors src/features/case-access/tokens.ts — the seed writes directly, no domain import. */
  function issueInvitation({ organizationId, caseId, participantId, invitedEmail }) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    return { token, hash, organizationId, caseId, participantId, invitedEmail };
  }

  const restrepoCase = await createCase({
    title: "Compraventa · Restrepo",
    primaryClientId: paola.id,
    participants: [
      { clientId: paola.id, role: "Comprador", requirements: [
        { label: "INE", state: "approved", fileName: "ine-paola.pdf" },
        { label: "CURP", state: "approved" },
        { label: "RFC", state: "approved" },
        { label: "Comprobante de domicilio", state: "review" },
      ]},
      { clientId: mateo.id, role: "Vendedor", requirements: [
        { label: "INE", state: "approved" },
        { label: "CURP", state: "approved" },
        { label: "Constancia de situación fiscal", state: "rejected", reason: "El documento está incompleto: falta la segunda página." },
        { label: "Título de propiedad", state: "missing" },
      ]},
    ],
  });

  // A real, usable invitation for Mateo — he has an approved item, a rejected one (with a
  // reason), and a pending one, so the portal's whole journey (upload / re-upload / quiet
  // approved section) is exercisable against real data. Issued directly, mirroring
  // issueInvitation() in src/features/case-access/invitations.ts.
  const mateoParticipant = restrepoCase.participants.find((p) => p.clientId === mateo.id);
  const invitation = issueInvitation({
    organizationId: org.id,
    caseId: restrepoCase.id,
    participantId: mateoParticipant.participantId,
    // The insert() helper only selects `id` by default, so `mateo` carries no email — this must
    // match the literal used when the client row was created above.
    invitedEmail: "mateo.restrepo@example.mx",
  });
  await insert("case_access_grants", {
    organization_id: invitation.organizationId,
    case_id: invitation.caseId,
    participant_id: invitation.participantId,
    invited_email: invitation.invitedEmail,
    invitation_token_hash: invitation.hash,
    permission: "upload",
  });

  await createCase({
    title: "Testamento · Villa",
    primaryClientId: ana.id,
    participants: [
      { clientId: ana.id, role: "Testador", requirements: [
        { label: "INE", state: "approved" },
        { label: "Inventario de bienes", state: "review" },
        { label: "Datos de testigos", state: "missing" },
      ]},
    ],
  });

  await createCase({
    title: "Poder notarial · Guzmán",
    primaryClientId: luis.id,
    state: "completed",
    participants: [
      { clientId: luis.id, role: "Otorgante", requirements: [
        { label: "INE", state: "approved" },
        { label: "Datos del apoderado", state: "approved" },
        { label: "Autorización firmada", state: "approved" },
      ]},
    ],
  });

  console.log("Seeded demo data.");
  console.log(`  Staff login: ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
  console.log(`  Organization: Notaría Central (${org.id})`);
  console.log(`  Client portal (Mateo Restrepo): http://localhost:3000/portal/${invitation.token}`);
  console.log(`    Invited email: ${invitation.invitedEmail} — check Mailpit at http://127.0.0.1:54424 for the code`);
}

main();
