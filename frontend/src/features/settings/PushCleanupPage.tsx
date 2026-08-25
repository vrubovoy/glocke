import { useEffect, useState } from 'react'
import { unsubscribeLocalPush } from '../../lib/push/localSubscription'

export function PushCleanupPage() {
  const [complete, setComplete] = useState(false)

  useEffect(() => {
    void unsubscribeLocalPush().finally(() => setComplete(true))
  }, [])

  return <div className="callback-screen">{complete ? 'Push-подписка этого браузера удалена.' : 'Удаление Push-подписки…'}</div>
}
