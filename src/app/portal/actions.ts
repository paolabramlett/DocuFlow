"use server";

/*
 * Server Actions for the Client Portal.
 *
 * Thin by the same rule as the Staff side (src/app/cases/actions.ts): authenticate or accept the
 * token, delegate to src/application/client-portal.ts, return a typed result. No business logic
 * here — retries, lifecycle transitions, and authorization all live in the use cases.
 */

import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import {
  cancelUploadSession,
  finalizeUpload,
  getClientDocumentUrl,
  getPortalState,
  prepareUpload,
  requestAccessCode,
  verifyAccessCode,
  type PortalState,
  type PrepareUploadResult,
} from "@/application/client-portal";

export async function requestAccessCodeAction(token: string): Promise<ActionResult<null>> {
  try {
    const supabase = await createClient();
    await requestAccessCode(supabase, { token });
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function verifyAccessCodeAction(token: string, code: string): Promise<ActionResult<PortalState>> {
  try {
    const supabase = await createClient();
    // Sets the session cookie on success (the server client's cookie adapter can write here,
    // unlike inside a Server Component render).
    await verifyAccessCode(supabase, { token, code });
    const state = await getPortalState(supabase, token);
    return ok(state);
  } catch (error) {
    return fail(error);
  }
}

export async function getPortalStateAction(token: string): Promise<ActionResult<PortalState>> {
  try {
    const supabase = await createClient();
    return ok(await getPortalState(supabase, token));
  } catch (error) {
    return fail(error);
  }
}

export async function prepareUploadAction(
  token: string,
  requirementId: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<ActionResult<PrepareUploadResult>> {
  try {
    const supabase = await createClient();
    return ok(await prepareUpload(supabase, { token, requirementId, fileName, contentType, sizeBytes }));
  } catch (error) {
    return fail(error);
  }
}

export async function finalizeUploadAction(sessionId: string): Promise<ActionResult<{ documentId: string }>> {
  try {
    const supabase = await createClient();
    const documentId = await finalizeUpload(supabase, sessionId);
    return ok({ documentId });
  } catch (error) {
    return fail(error);
  }
}

export async function cancelUploadSessionAction(sessionId: string): Promise<ActionResult<null>> {
  try {
    const supabase = await createClient();
    await cancelUploadSession(supabase, sessionId);
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function getClientDocumentUrlAction(
  token: string,
  documentId: string,
  download?: boolean,
): Promise<ActionResult<string>> {
  try {
    const supabase = await createClient();
    return ok(await getClientDocumentUrl(supabase, { token, documentId, download }));
  } catch (error) {
    return fail(error);
  }
}
