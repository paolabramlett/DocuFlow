import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTransactionalEmail } from '@/lib/email/resend';

describe('sendTransactionalEmail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the Resend API with the required headers and body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'test' }), { status: 200 }),
    );

    await sendTransactionalEmail({
      to: 'someone@example.test',
      subject: 'Test subject',
      html: '<p>hi</p>',
      idempotencyKey: 'test-key-123',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('avanza/1.0');
    expect(headers['Idempotency-Key']).toBe('test-key-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      to: 'someone@example.test',
      subject: 'Test subject',
      html: '<p>hi</p>',
    });
  });

  it('omits the Idempotency-Key header when none is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'test' }), { status: 200 }),
    );

    await sendTransactionalEmail({ to: 'someone@example.test', subject: 'S', html: '<p>h</p>' });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect('Idempotency-Key' in headers).toBe(false);
  });

  it('throws a redacted error on a non-ok response, never the raw body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'validation_error', message: 'to: invalid recipient list' }), {
        status: 422,
      }),
    );

    await expect(
      sendTransactionalEmail({ to: 'bad', subject: 'S', html: '<p>h</p>' }),
    ).rejects.toThrow(/422/);
  });
});
