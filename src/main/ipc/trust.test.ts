import { describe, expect, it } from 'vitest'
import { isTrustedSenderUrl, type TrustedOrigins } from './trust'

const prod: TrustedOrigins = {
  rendererFileUrl: 'file:///Applications/Shokuba.app/renderer/index.html',
}
const dev: TrustedOrigins = { ...prod, devServerUrl: 'http://localhost:5173' }

describe('isTrustedSenderUrl', () => {
  it('trusts the built renderer page, including with a hash or query', () => {
    expect(isTrustedSenderUrl('file:///Applications/Shokuba.app/renderer/index.html', prod)).toBe(
      true,
    )
    expect(
      isTrustedSenderUrl('file:///Applications/Shokuba.app/renderer/index.html#/office', prod),
    ).toBe(true)
    expect(
      isTrustedSenderUrl('file:///Applications/Shokuba.app/renderer/index.html?x=1', prod),
    ).toBe(true)
  })

  it('rejects any other local file', () => {
    expect(isTrustedSenderUrl('file:///tmp/evil.html', prod)).toBe(false)
    expect(isTrustedSenderUrl('file:///Applications/Shokuba.app/renderer/other.html', prod)).toBe(
      false,
    )
  })

  it('rejects every http(s) origin in production', () => {
    expect(isTrustedSenderUrl('http://localhost:5173/', prod)).toBe(false)
    expect(isTrustedSenderUrl('https://example.com/', prod)).toBe(false)
  })

  it('trusts only the exact dev server origin in development', () => {
    expect(isTrustedSenderUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:5173/some/route', dev)).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedSenderUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isTrustedSenderUrl('https://localhost:5173/', dev)).toBe(false)
  })

  it.each([
    '',
    'not a url',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'about:blank',
    'chrome://gpu',
  ])('rejects %j', (url) => {
    expect(isTrustedSenderUrl(url, dev)).toBe(false)
  })
})
