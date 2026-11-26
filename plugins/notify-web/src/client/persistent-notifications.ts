/** A separate, narrow worker registration does not control the DSH page. */
export function persistentNotifications(base: URL) {
  if (navigator.serviceWorker === undefined) return undefined
  const script = new URL('api/notify-web/worker.js', base)
  let registration: Promise<ServiceWorkerRegistration> | undefined
  const ready = (): Promise<ServiceWorkerRegistration> => {
    registration ??= navigator.serviceWorker.register(script.href, { updateViaCache: 'none' }).then(async value => {
      if (!value.active) {
        const worker = value.installing ?? value.waiting
        if (!worker) throw new Error('notify-web worker missing')
        await new Promise<void>((resolve, reject) => {
          const changed = (): void => {
            if (worker.state !== 'activated' && worker.state !== 'redundant') return
            worker.removeEventListener('statechange', changed)
            if (worker.state === 'activated') resolve()
            else reject(new Error('notify-web worker activation failed'))
          }
          worker.addEventListener('statechange', changed)
          changed()
        })
      }
      return value
    }).catch(error => { registration = undefined; throw error })
    return registration
  }
  // Serialize show/withdraw so an answer arriving during registration cannot
  // leave a notification behind after its withdrawal.
  let queue = Promise.resolve()
  const run = (action: (value: ServiceWorkerRegistration) => Promise<void>): Promise<void> => {
    const result = queue.catch(() => {}).then(async () => action(await ready()))
    queue = result
    return result
  }
  return {
    script,
    show(id: string, sessionId: string, title: string, body: string, tag: string) {
      return run(async value => {
        if ((await value.getNotifications({ tag })).length) return
        await value.showNotification(title, { body, tag, requireInteraction: true, data: { id, sessionId } })
      })
    },
    close(id: string) {
      return run(async value => {
        for (const notification of await value.getNotifications()) {
          if (notification.data?.id === id) notification.close()
        }
      })
    },
    reconcile(pending: Set<string>) {
      return run(async value => {
        for (const notification of await value.getNotifications()) {
          const id: unknown = notification.data?.id
          if (typeof id === 'string' && (id.includes(':approval:') || id.includes(':question:')) && !pending.has(id)) notification.close()
        }
      })
    },
  }
}
