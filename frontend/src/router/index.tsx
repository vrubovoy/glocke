import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { NotFoundPage } from '@zudar107/schloss-ui'
import { Layout } from '../components/Layout'
import { NotificationCenter } from '../features/notifications/NotificationCenter'
import { SettingsPage } from '../features/settings/SettingsPage'
import { HelpPage } from '../features/help/HelpPage'
import { DocsPage } from '../features/docs/DocsPage'
import { AuthCallbackPage } from '../features/auth/AuthCallbackPage'
import { PushCleanupPage } from '../features/settings/PushCleanupPage'
import { getAccessToken } from '../lib/api'
import { buildSchluesselLoginUrl } from '../lib/authRedirect'
import { queryClient } from '../lib/queryClient'

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
  notFoundComponent: () => <NotFoundPage homeHref="/" />,
})
const callback = createRoute({ getParentRoute: () => root, path: '/auth/callback', component: AuthCallbackPage })
const pushCleanup = createRoute({ getParentRoute: () => root, path: '/push-cleanup', component: PushCleanupPage })
const protectedRoute = createRoute({
  getParentRoute: () => root,
  id: 'protected',
  beforeLoad: async () => {
    if (!getAccessToken()) location.href = await buildSchluesselLoginUrl(location.pathname + location.search)
  },
  component: () => <Layout><Outlet /></Layout>,
})
const index = createRoute({ getParentRoute: () => protectedRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/notifications' }) } })
const notifications = createRoute({ getParentRoute: () => protectedRoute, path: '/notifications', component: NotificationCenter })
const settings = createRoute({ getParentRoute: () => protectedRoute, path: '/settings', component: SettingsPage })
const help = createRoute({ getParentRoute: () => protectedRoute, path: '/help', component: HelpPage })
const docs = createRoute({ getParentRoute: () => protectedRoute, path: '/docs', component: DocsPage })
const routeTree = root.addChildren([callback, pushCleanup, protectedRoute.addChildren([index, notifications, settings, help, docs])])
export const router = createRouter({ routeTree, context: { queryClient } })

declare module '@tanstack/react-router' { interface Register { router: typeof router } }
