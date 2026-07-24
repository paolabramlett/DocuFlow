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

config({ path: ".env.local", quiet: true });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing env. Run: npm run db:start && npm run db:env");
  process.exit(1);
}

const STAFF_EMAIL = "staff@docuflow.mx";
const STAFF_PASSWORD = "docuflow-demo-2026";

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

    for (const p of participants) {
      const part = await insert("case_participants", {
        organization_id: org.id,
        case_id: c.id,
        client_id: p.clientId,
        role_label: p.role,
      });

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
          const doc = await insert("documents", {
            organization_id: org.id,
            case_id: c.id,
            requirement_id: req.id,
            storage_path: `${org.id}/cases/${c.id}/requirements/${req.id}/${crypto.randomUUID()}`,
            file_name: r.fileName ?? "documento.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
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
    return c;
  }

  await createCase({
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
}

main();
