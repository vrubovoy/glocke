import { useState } from 'react'
import { Bell, CircleHelp, FileCode2, Menu, Settings } from 'lucide-react'
import { Link, useLocation } from '@tanstack/react-router'
import {
  Footer, Header, Sidebar, ThemeToggle, useAvatarUrl, useUnreadNotifications,
  type SidebarLinkRenderProps,
} from '@zudar107/schloss-ui'
import { useAuth } from '../hooks/useAuth'
import { apiClient } from '../lib/api'
import { buildSchluesselAccountUrl, buildSchluesselLogoutUrl } from '../lib/authRedirect'
import { unsubscribeLocalPush } from '../lib/push/localSubscription'
import { getRuntimeConfig } from '../lib/runtimeConfig'

const SIDEBAR_WIDTH_STORAGE_KEY = 'glocke-sidebar-width'

const NAV_ITEMS = [
  { to: '/notifications', icon: <Bell size={18} />,       label: 'Уведомления' },
  { to: '/settings',      icon: <Settings size={18} />,   label: 'Настройки' },
  { to: '/help',          icon: <CircleHelp size={18} />, label: 'Справка' },
]

// Admin-only, appended rather than baked into NAV_ITEMS - /docs 403s the
// API request for anyone else, so hiding the link avoids a dead-end click.
const DOCS_NAV_ITEM = { to: '/docs', icon: <FileCode2 size={18} />, label: 'API' }

const BRAND_MARK = <Bell size={16} />

function renderNavLink({ to, icon, label, collapsed, style, onClick, onMouseEnter, onMouseLeave }: SidebarLinkRenderProps) {
  return (
    <Link key={to} to={to} onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={style}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      {!collapsed && label}
    </Link>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const { schlossUrl, schlusselUrl } = getRuntimeConfig()
  const [mobileOpen, setMobileOpen] = useState(false)
  const notificationState = useUnreadNotifications({
    glockeOrigin: window.location.origin,
    userId: user?.id ?? null,
    apiClient,
  })
  const avatarUrl = useAvatarUrl({
    schluesselOrigin: schlusselUrl,
    userId: user?.id ?? null,
    apiClient,
  })

  const navItems = user?.role === 'admin' ? [...NAV_ITEMS, DOCS_NAV_ITEM] : NAV_ITEMS

  async function signOut() {
    void unsubscribeLocalPush()
    await logout()
    location.href = buildSchluesselLogoutUrl()
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar
        storageKey={SIDEBAR_WIDTH_STORAGE_KEY}
        ariaLabel="Разделы Glocke"
        brandName="Glocke"
        brandMark={BRAND_MARK}
        navItems={navItems}
        activePath={pathname}
        renderLink={renderNavLink}
        user={user ? { name: user.name, email: user.email } : null}
        onAccountClick={() => { location.href = buildSchluesselAccountUrl(pathname) }}
        onLogout={() => void signOut()}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Header
          logo={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
          homeHref={schlossUrl}
          user={user ? { ...user, avatarUrl } : null}
          notifications={{ href: '/notifications', state: notificationState, glockeOrigin: window.location.origin, apiClient }}
          onSettings={() => { location.href = buildSchluesselAccountUrl(pathname) }}
          onLogout={() => void signOut()}
          rightSlot={<ThemeToggle />}
          leftSlot={
            <button
              onClick={() => setMobileOpen(true)}
              className="show-mobile"
              aria-label="Меню"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, display: 'flex' }}
            >
              <Menu size={20} />
            </button>
          }
        />

        {/* minHeight: 0 is required here - a flex item defaults to
            min-height: auto, which lets it grow to fit tall content
            instead of scrolling within its allotted space. Without it,
            long pages push past the viewport and the Footer below gets
            clipped by the parent's overflow: hidden - not just "needs
            scrolling", genuinely unreachable. */}
        <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2rem clamp(1rem, 4vw, 3.5rem)' }}>
          {children}
        </main>

        <Footer serviceName="Glocke" description="Центр уведомлений Hof" version={__APP_VERSION__} helpHref="/help" />
      </div>
    </div>
  )
}
