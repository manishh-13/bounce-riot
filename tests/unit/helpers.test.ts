import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/ui/helpers';
describe('untrusted nickname output', () => {
  it('escapes script markup and attribute delimiters', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("Mom & Dad's \"party\"")).toBe('Mom &amp; Dad&#39;s &quot;party&quot;');
  });
});
