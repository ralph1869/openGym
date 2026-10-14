// Upstream instances keep every existing entry. The personal Worker advertises its smaller
// surface explicitly; its build also hides those entries while public config is still loading.
export const CLOUDFLARE_PERSONAL = import.meta.env.VITE_CLOUDFLARE === '1'
export const supports = (config, feature) => config?.capabilities?.[feature] ?? !CLOUDFLARE_PERSONAL
export const registrationAllowed = config => config?.registration_open ?? !CLOUDFLARE_PERSONAL
export const sourceUrl = config => config?.source_url || import.meta.env.VITE_SOURCE_URL || 'https://github.com/DuarteSantos8/openGym'
