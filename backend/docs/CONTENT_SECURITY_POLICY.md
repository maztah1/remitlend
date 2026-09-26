# Content Security Policy (CSP)

This document describes RemitLend's Content Security Policy configuration and how to use nonce-based script allowlisting to prevent XSS attacks.

## Overview

Content Security Policy is a security mechanism that restricts where scripts, styles, images, and other resources can be loaded from. RemitLend uses per-request nonces to allow specific inline scripts while blocking all other inline code.

## Policy Directives

The following CSP directives are enforced:

| Directive | Production | Development |
|-----------|-----------|-------------|
| `default-src` | `'self'` | `'self'` |
| `script-src` | `'nonce-{unique}'` | `'nonce-{unique}' 'unsafe-inline'` |
| `style-src` | `'self' https: 'unsafe-inline'` | `'self' https: 'unsafe-inline'` |
| `img-src` | `'self' data: https:` | `'self' data: https:` |
| `font-src` | `'self' https: data:` | `'self' https: data:` |
| `frame-ancestors` | `'self'` | `'self'` |
| `connect-src` | `'self'` | `'self'` |
| `form-action` | `'self'` | `'self'` |
| `report-uri` | `/api/v1/csp-report` | (none) |

## Nonce-Based Script Allowlisting

### How It Works

Every HTTP response includes a unique nonce (number used once):

1. Server generates a random 16-byte nonce and encodes it as base64
2. Nonce is included in the CSP header: `script-src 'nonce-abc123xyz'`
3. Inline `<script>` tags with matching nonce are allowed: `<script nonce="abc123xyz">...</script>`
4. Any inline scripts without the nonce are blocked

### Advantages Over unsafe-inline

- **unsafe-inline** allows ALL inline scripts (including injected XSS)
- **'nonce-X'** allows ONLY scripts you explicitly mark with the nonce
- Per-request nonces prevent attackers from guessing the nonce across multiple requests

## Using CSP Nonces

### In Node/Express Controllers

The request object includes the generated nonce:

```typescript
import { Request, Response } from 'express';

export function renderPage(req: Request, res: Response) {
  const nonce = req.cspNonce;
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <!-- This script is allowed -->
        <script nonce="${nonce}">
          console.log('This script is allowed');
        </script>
      </head>
      <body>
        <!-- This script BLOCKED (no nonce) -->
        <script>
          console.log('This script is blocked');
        </script>
      </body>
    </html>
  `);
}
```

### In Response Locals (for templates)

The nonce is also available in `res.locals`:

```typescript
res.render('page', {
  nonce: res.locals.cspNonce,
  // ... other data
});
```

### In Handlebars/Pug Templates

```handlebars
<!-- Handlebars example -->
<script nonce="{{nonce}}">
  console.log('This script is allowed');
</script>
```

```pug
// Pug example
script(nonce=nonce)
  console.log('This script is allowed')
```

## CSP Violation Reporting

### Report Endpoint

When the browser blocks a CSP violation, it sends a report to:

```
POST /api/v1/csp-report
Content-Type: application/csp-report
```

### Report Format

The browser sends a JSON report with details:

```json
{
  "csp-report": {
    "document-uri": "https://app.remitlend.io/dashboard",
    "violated-directive": "script-src 'nonce-abc123'",
    "original-policy": "script-src 'nonce-abc123'; default-src 'self'",
    "blocked-uri": "https://attacker.com/malicious.js",
    "source-file": "https://app.remitlend.io/dashboard",
    "line-number": 42,
    "column-number": 10,
    "disposition": "enforce"
  }
}
```

### Violation Logging

Violations are logged based on disposition:

- `disposition: "enforce"` → Logged at WARN level (script was blocked)
- `disposition: "report-only"` → Logged at INFO level (for monitoring)

Monitor logs for CSP violations:

```bash
# Find all CSP violations
tail -f logs/app.log | grep "CSP violation"

# Count violations by directive
grep "CSP violation" logs/app.log | jq '.violatedDirective' | sort | uniq -c
```

The frontend also listens for `securitypolicyviolation` events. It truncates
browser-provided fields to bounded lengths and sends the report to the backend
with `navigator.sendBeacon`, using a keepalive `fetch` fallback when Beacon is
unavailable. This supplements the browser's native `report-uri` delivery and
is intended for diagnostics only; it does not relax the policy or include
session tokens.

## CSP Exceptions

### When to Add Exceptions

Only add CSP exceptions when:

1. **Third-party services are required**: e.g., analytics, monitoring, payment processors
2. **Legacy code must be supported**: Before rewriting, whitelist the origin
3. **Development convenience**: Loosen CSP in dev/staging, enforce in production

### Adding Exceptions

Edit `middleware/cspNonce.ts` `getCSPHeaders()` function:

```typescript
export function getCSPHeaders(nonce: string, isProduction: boolean): Record<string, string> {
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': scriptSrc,
    // Add third-party script exception
    'script-src': `${scriptSrc} https://trusted-cdn.example.com`,
    // Add third-party style exception
    'style-src': "'self' https: 'unsafe-inline' https://fonts.googleapis.com",
    // Add connect exception for API calls
    'connect-src': "'self' https://api.external-service.com",
  };
  // ...
}
```

### Common Exceptions

| Use Case | Directive | Exception |
|----------|-----------|-----------|
| Google Fonts | `font-src` | `https://fonts.gstatic.com` |
| Cloudflare CDN | `script-src` | `https://cdnjs.cloudflare.com` |
| External API | `connect-src` | `https://api.example.com` |
| Sentry error tracking | `connect-src` | `https://*.ingest.sentry.io` |

## Testing CSP

### Browser DevTools

1. Open DevTools (F12) → Console tab
2. Look for CSP violations:
   ```
   Refused to load the script 'https://...' because it violates the following 
   Content Security Policy directive: "script-src 'nonce-abc123'"
   ```

### Testing With curl

```bash
curl -i https://api.remitlend.io/

# Look for CSP header in response:
# Content-Security-Policy: default-src 'self'; script-src 'nonce-abc123'; ...
```

### Inspecting Nonce

```bash
curl -s https://api.remitlend.io/ | grep -oP "nonce-\K[^']*" | head -1
# Output: abc123xyz...
```

## Development vs Production

### Development Mode (NODE_ENV !== 'production')

- `script-src` includes both nonce AND `'unsafe-inline'`
- Allows inline scripts for easier debugging
- CSP violations logged to console
- Report-URI not set (violations only logged server-side)

### Production Mode (NODE_ENV === 'production')

- `script-src` includes ONLY the nonce
- Inline scripts MUST have matching nonce or they're blocked
- CSP violations sent to `/api/v1/csp-report`
- Violations monitored and alerted

## Security Notes

### Nonce Regeneration

- A new nonce is generated for EVERY request
- Nonces are not reused (prevents brute-force guessing)
- Previous nonces never work in future requests
- Server does NOT log/track nonces (they're one-time use)

### Hash-Based Allowlisting

For static inline scripts with known content, you can use hashes instead of nonces:

```
script-src 'sha256-{hash-of-script-contents}'
```

However, RemitLend uses nonces as they're more flexible for dynamic content.

### XSS Prevention

CSP with nonces prevents:

- **Inline `<script>` injection**: Attacker-injected `<script>alert('xss')</script>` blocked
- **Event handler injection**: Attacker-injected `onclick="alert('xss')"` blocked
- **Style-based attacks**: Injected `<style>` tags blocked

CSP does NOT prevent:

- **DOM-based XSS**: JavaScript that parses untrusted input must still sanitize
- **Server-side template injection**: Always escape template variables
- **SQL injection**: Always use parameterized queries

## Debugging CSP Issues

### Problem: Script Not Running

**Error**: `Refused to load script ... because it violates Content Security Policy directive`

**Solution**: Add the nonce to the script tag:

```html
<!-- ❌ BLOCKED -->
<script>console.log('hello')</script>

<!-- ✅ ALLOWED -->
<script nonce="<%= nonce %>">console.log('hello')</script>
```

### Problem: External CDN Scripts Not Loading

**Error**: `Refused to load script from external-cdn.com`

**Solution**: Add the CDN to `script-src` exceptions in `cspNonce.ts`

### Problem: Styles Not Applied

**Error**: `Refused to apply inline style ... because it violates Content Security Policy`

**Solution**: Move styles to external stylesheet or add `'unsafe-inline'` to `style-src` (already included)

## References

- [MDN Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Nonces](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#nonce-_-base64-value)
- [CSP Evaluator](https://csp-evaluator.withgoogle.com/)
