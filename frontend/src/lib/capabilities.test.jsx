// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { bindUI } from '../components/ui.jsx'
import { supports, registrationAllowed, sourceUrl } from './capabilities.js'
import { pageVisible, searchSettings } from '../views/settings-pages.js'
import Settings from '../views/Settings.jsx'
import Login from '../views/Login.jsx'

const config = { deployment: 'cloudflare-personal', allow_guest: false, registration_open: false,
  source_url: 'https://github.com/ralph1869/openGym/tree/feat/cloudflare-d1', capabilities: {
    passkey_management: false, device_link: false, pairing: false, push: false, media_upload: false
  } }
const roots = []
globalThis.IS_REACT_ACT_ENVIRONMENT = true
bindUI(useUI)
afterEach(async () => { for (const [r, h] of roots.splice(0)) { await act(async () => r.unmount()); h.remove() }; vi.restoreAllMocks() })
const render = async el => {
  const h = document.createElement('div'); document.body.append(h); const r = createRoot(h); roots.push([r, h]);
  await act(async () => r.render(<MemoryRouter>{el}</MemoryRouter>)); return h
}
describe('personal Worker capabilities', () => {
  it('preserves older instances and honours explicit capability and registration flags', () => {
    expect(supports(null, 'pairing')).toBe(true)
    expect(supports(config, 'pairing')).toBe(false)
    expect(registrationAllowed(config)).toBe(false)
    expect(sourceUrl(config)).toContain('ralph1869/openGym')
  })
  it('hides unsupported account actions and reminder pages/search results', async () => {
    useStore.setState({ S: structuredClone(DEF), config, user: { id: 'test', name: 'Synthetic' }, ready: true })
    const h = await render(<Settings page="account" />)
    const text = h.textContent
    expect(text).toContain('Cloudflare 个人版')
    for (const label of ['Pair the mobile app', 'Add another device', 'Add passkey']) expect(text).not.toContain(label)
    const ctx = { user: { id: 'test' }, config, synced: true }
    expect(pageVisible('reminders', ctx)).toBe(false)
    for (const q of ['Pair the mobile app', 'Add another device']) expect(searchSettings(q, ctx)).toHaveLength(0)
  })
  it('the closed login offers sign-in, without guest, registration or pairing', async () => {
    useStore.setState({ S: structuredClone(DEF), config, user: null, ready: true })
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} })
    const h = await render(<Login />)
    expect(h.textContent).toContain('Sign in with passkey')
    for (const label of ['Create new profile', 'Continue without account', 'Use a code from your other device']) expect(h.textContent).not.toContain(label)
  })
})
