import { RouterProvider } from '@tanstack/react-router'
import { ThemeSync } from '@zudar107/schloss-ui'
import { AuthContext, useAuthProvider } from './hooks/useAuth'
import { router } from './router'
import { getRuntimeConfig } from './lib/runtimeConfig'

export function App() {
  const auth = useAuthProvider()
  const { schlusselUrl } = getRuntimeConfig()
  const theme = <ThemeSync apiOrigin={schlusselUrl} />
  if (auth.loading) return <>{theme}<div className="callback-screen">Загрузка…</div></>
  return <AuthContext.Provider value={auth}>{theme}<RouterProvider router={router} /></AuthContext.Provider>
}
