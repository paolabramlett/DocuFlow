import { describe, expect, it, vi } from 'vitest';
import { uploadFileDirectly } from '@/lib/upload/direct-upload';

// jsdom's XMLHttpRequest is a real, usable implementation for this — no need to mock the class
// itself, only the network layer underneath it via a fake XHR that this test controls directly.
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  body: unknown;
  aborted = false;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('uploadFileDirectly', () => {
  it('PUTs to the signed URL with the token appended, and reports progress', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const onProgress = vi.fn();
    const controller = new AbortController();
    const file = new File(['hello'], 'ine.pdf', { type: 'application/pdf' });

    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file,
      onProgress,
      signal: controller.signal,
    });

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toContain('token=the-token');
    expect(xhr.body).toBeInstanceOf(FormData);

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(50);

    xhr.status = 200;
    xhr.onload?.();
    await promise;

    globalThis.XMLHttpRequest = originalXHR;
  });

  it('rejects when the underlying XHR reports an error status', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file: new File(['x'], 'x.pdf', { type: 'application/pdf' }),
      onProgress: () => {},
      signal: new AbortController().signal,
    });

    const xhr = FakeXHR.instances[0]!;
    xhr.status = 409;
    xhr.onload?.();

    await expect(promise).rejects.toThrow();
    globalThis.XMLHttpRequest = originalXHR;
  });

  it('rejects when the abort signal fires mid-upload', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const controller = new AbortController();
    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file: new File(['x'], 'x.pdf', { type: 'application/pdf' }),
      onProgress: () => {},
      signal: controller.signal,
    });

    const xhr = FakeXHR.instances[0]!;
    controller.abort();
    expect(xhr.aborted).toBe(true);

    await expect(promise).rejects.toThrow();
    globalThis.XMLHttpRequest = originalXHR;
  });
});
