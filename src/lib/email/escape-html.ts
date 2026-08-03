/**
 * Escapes text before it is interpolated into an email's HTML body. Every email template in
 * `src/application/` builds its `html` via raw template-string interpolation (no JSX, no DOM) —
 * any free text a Staff member or Client entered (a rejection reason, an Organization name) must
 * go through this first, or it becomes literal HTML in the recipient's inbox.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
