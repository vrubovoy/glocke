import { buildAccountUrl, buildLoginUrl, buildLogoutUrl, CODE_VERIFIER_STORAGE_KEY } from '@zudar107/schloss-ui'
import { getRuntimeConfig } from './runtimeConfig'

const config = () => ({
  schluesselUrl: getRuntimeConfig().schlusselUrl,
})

export { CODE_VERIFIER_STORAGE_KEY }
export const buildSchluesselLoginUrl = (path: string, origin?: string) => buildLoginUrl(config(), path, origin)
export const buildSchluesselLogoutUrl = (returnTo?: string) => buildLogoutUrl(config(), returnTo)
export const buildSchluesselAccountUrl = (path: string, origin?: string) => buildAccountUrl(config(), path, origin)
