/**
 * Uploads a file directly to a Supabase Storage signed upload URL, via XMLHttpRequest rather than
 * fetch() — this is a deliberate choice, not an oversight: the Fetch API has no standardized,
 * cross-browser mechanism for observing upload progress, while XMLHttpRequest.upload.onprogress
 * (paired with xhr.abort() for real cancellation) does. Verified against storage-js's own
 * uploadToSignedUrl implementation (storage-js@2.110.8, src/packages/StorageFileApi.ts): same
 * method (PUT), same FormData shape (cacheControl + the file appended under the empty-string key)
 * — this function reproduces that exact wire request so the server side of the exchange is
 * unchanged.
 *
 * On the token query param: `createSignedUploadUrl`'s response embeds the token in `signedUrl`
 * already, but `uploadToSignedUrl` itself never relies on that — it's called with `path` + `token`
 * as separate arguments and builds the URL from scratch, setting `?token=` explicitly every time.
 * This module takes the same stance: it sets the token param explicitly rather than trusting that
 * whatever `signedUrl` string it was handed already carries it, since `URLSearchParams.set` is
 * idempotent when the value is already present and correct either way.
 */
export interface UploadFileDirectlyInput {
  readonly signedUrl: string;
  readonly token: string;
  readonly file: File;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export function uploadFileDirectly(input: UploadFileDirectlyInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = new URL(input.signedUrl);
    url.searchParams.set('token', input.token);
    xhr.open('PUT', url.toString());

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      input.onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    if (input.signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    input.signal.addEventListener('abort', () => xhr.abort(), { once: true });

    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', input.file);
    xhr.send(body);
  });
}
