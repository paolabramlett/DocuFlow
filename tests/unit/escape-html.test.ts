import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@/lib/email/escape-html';

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and \'', () => {
    expect(escapeHtml(`<script>alert("hi & 'bye'")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;hi &amp; &#39;bye&#39;&quot;)&lt;/script&gt;',
    );
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('El documento está incompleto.')).toBe('El documento está incompleto.');
  });
});
