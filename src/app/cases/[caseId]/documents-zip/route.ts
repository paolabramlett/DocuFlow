/*
 * Streams every current Document of a Case as one zip, one folder per Participant — the
 * "Descargar todo" batch export. A plain GET so a browser can drive it from an <a href>/download
 * link; the session cookie carries authentication exactly like any other Route Handler here.
 */

import JSZip from "jszip";
import { NextResponse } from "next/server";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getCaseDocumentsForDownload } from "@/features/documents/documents";
import { CASE_DOCUMENTS_BUCKET } from "@/lib/storage/paths";

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "sin-nombre";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;

  const staff = await getStaffContext();
  if (!staff) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const supabase = await createClient();
  const documents = await getCaseDocumentsForDownload(supabase, caseId);

  if (documents.length === 0) {
    return NextResponse.json({ error: "no_documents" }, { status: 404 });
  }

  const zip = new JSZip();
  const usedNames = new Map<string, number>();

  for (const doc of documents) {
    const { data, error } = await supabase.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .download(doc.storagePath);
    if (error || !data) continue;

    const folder = sanitize(doc.participantName);
    const baseName = `${sanitize(doc.requirementLabel)} — ${doc.fileName}`;
    const key = `${folder}/${baseName}`;
    const priorUses = usedNames.get(key) ?? 0;
    usedNames.set(key, priorUses + 1);
    const finalName = priorUses === 0 ? baseName : `${baseName} (${priorUses})`;

    zip.folder(folder)?.file(finalName, await data.arrayBuffer());
  }

  const buffer = await zip.generateAsync({ type: "arraybuffer" });

  return new NextResponse(new Blob([buffer]), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="expediente-${caseId.slice(0, 8)}-documentos.zip"`,
    },
  });
}
