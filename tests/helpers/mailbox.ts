/**
 * Reads the local Mailpit inbox that the Supabase stack delivers to.
 *
 * The OTP tests go through real delivery rather than a stubbed code, because the property under
 * test is *which mailbox the code reaches* — a stub would pass even if the address came from the
 * caller instead of the grant row.
 */

const MAILPIT_URL = 'http://127.0.0.1:54424';

interface MailpitSummary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
}

interface MailpitMessage {
  readonly Text: string;
  readonly HTML: string;
  readonly To: readonly { readonly Address: string }[];
}

export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
}

async function listMessages(): Promise<MailpitSummary[]> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`);
  if (!response.ok) throw new Error(`Mailpit list failed: ${response.status}`);
  const body = (await response.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

async function readMessage(id: string): Promise<MailpitMessage> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  if (!response.ok) throw new Error(`Mailpit read failed: ${response.status}`);
  return (await response.json()) as MailpitMessage;
}

/** Every address the stack has delivered to since the last clear. */
export async function deliveredRecipients(): Promise<string[]> {
  const messages = await listMessages();
  return messages.flatMap((message) => message.To.map((to) => to.Address.toLowerCase()));
}

/**
 * Waits for a passcode addressed to `email` and returns it.
 *
 * Polls because delivery is asynchronous; fails rather than hanging if nothing arrives.
 */
export async function waitForOtp(email: string, timeoutMs = 10_000): Promise<string> {
  const target = email.toLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const summary of await listMessages()) {
      const addressed = summary.To.some((to) => to.Address.toLowerCase() === target);
      if (!addressed) continue;

      const message = await readMessage(summary.ID);
      const code = `${message.Text}\n${message.HTML}`.match(/\b(\d{6})\b/);
      if (code?.[1]) return code[1];
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No passcode delivered to ${email} within ${timeoutMs}ms`);
}
