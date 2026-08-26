import { beforeEach, describe, expect, it } from 'vitest'
import { createProcessor } from '../processor.js'
import { eventEnvelope, inboxRecord, notificationRecord } from './helpers/fixtures.js'
import { MemoryNotificationRepository } from './helpers/repository.js'

describe('inbox processing', () => {
  let repository: MemoryNotificationRepository

  beforeEach(() => {
    repository = new MemoryNotificationRepository()
  })

  function processor(notifyInApp = true) {
    return createProcessor({
      repository,
      resolveRecipient: async (userId) => ({ userId, notifyInApp, notifyBrowserPush: false }),
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createId: () => 'notification-1',
      createLeaseId: () => 'lease-1',
    })
  }

  it('processes one pending inbox event and is idle on the next pass', async () => {
    repository.seedInbox(inboxRecord())
    const worker = processor()

    expect(await worker.processNext()).toBe('processed')
    expect(await worker.processNext()).toBe('idle')
    expect(repository.inbox[0]).toMatchObject({ status: 'processed' })
    expect(repository.notifications).toHaveLength(1)
  })

  it('is idempotent when notification creation committed before inbox completion failed', async () => {
    repository.seedInbox(inboxRecord())
    repository.failNextCompletion = true
    const worker = processor()

    await expect(worker.processNext()).rejects.toThrow('simulated completion failure')
    expect(repository.notifications).toHaveLength(1)
    repository.recoverProcessing()

    expect(await worker.processNext()).toBe('processed')
    expect(repository.notifications).toHaveLength(1)
    expect(repository.inbox[0]?.status).toBe('processed')
  })

  it('marks the inbox processed without creating a notification when notifyInApp is false', async () => {
    repository.seedInbox(inboxRecord())

    expect(await processor(false).processNext()).toBe('processed')
    expect(repository.notifications).toHaveLength(0)
    expect(repository.inbox[0]?.status).toBe('processed')
  })

  it('durably suppresses an event when the recipient no longer exists', async () => {
    repository.seedInbox(inboxRecord())
    const worker = createProcessor({
      repository,
      resolveRecipient: async () => null,
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createLeaseId: () => 'lease-1',
    })

    expect(await worker.processNext()).toBe('processed')
    expect(repository.notifications).toHaveLength(0)
    expect(repository.inbox[0]).toMatchObject({ status: 'processed', leaseId: null })
  })

  it('checks the lease using a timestamp captured after recipient resolution', async () => {
    repository.seedInbox(inboxRecord())
    let current = new Date('2026-08-07T10:00:00.000Z')
    const worker = createProcessor({
      repository,
      resolveRecipient: async (userId) => {
        current = new Date('2026-08-07T10:00:31.000Z')
        return { userId, notifyInApp: true, notifyBrowserPush: false }
      },
      now: () => current,
      createLeaseId: () => 'lease-1',
      leaseMs: 30_000,
    })

    expect(await worker.processNext()).toBe('idle')
    expect(repository.notifications).toHaveLength(0)
    expect(repository.inbox[0]).toMatchObject({ status: 'processing', leaseId: 'lease-1' })
  })

  it('captures a fresh completion timestamp after notification materialization', async () => {
    repository.seedInbox(inboxRecord())
    let current = new Date('2026-08-07T10:00:00.000Z')
    const materializeNotification = repository.materializeNotification.bind(repository)
    repository.materializeNotification = async (...args) => {
      const result = await materializeNotification(...args)
      current = new Date('2026-08-07T10:00:31.000Z')
      return result
    }
    const worker = createProcessor({
      repository,
      resolveRecipient: async (userId) => {
        current = new Date('2026-08-07T10:00:10.000Z')
        return { userId, notifyInApp: true, notifyBrowserPush: false }
      },
      now: () => current,
      createId: () => 'notification-1',
      createLeaseId: () => 'lease-1',
      leaseMs: 30_000,
    })

    expect(await worker.processNext()).toBe('idle')
    expect(repository.notifications).toHaveLength(1)
    expect(repository.inbox[0]).toMatchObject({ status: 'processing', leaseId: 'lease-1' })
  })

  it('enforces notification uniqueness by event and recipient', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedNotification(notificationRecord())

    expect(await processor().processNext()).toBe('processed')
    expect(repository.notifications).toHaveLength(1)
    expect(repository.notifications[0]).toMatchObject({ eventId: '10000000-0000-4000-8000-000000000001', userId: 'user-1' })
  })

  it('renders the minimal password-changed event in Russian', async () => {
    const envelope = eventEnvelope({
      source: 'schlussel',
      type: 'schlussel.security.password_changed.v1',
      payload: { recipientId: 'user-1' },
    })
    repository.seedInbox(inboxRecord({ envelope, source: 'schlussel' }))

    expect(await processor().processNext()).toBe('processed')
    expect(repository.notifications[0]).toMatchObject({
      title: 'Пароль изменён',
      body: 'Пароль вашей учётной записи был изменён.',
      actionUrl: '/settings',
    })
  })

  it.each([
    {
      source: 'kuvert',
      type: 'kuvert.goal.completed.v1',
      payload: { recipientId: 'user-1', goalName: 'Резервный фонд' },
      expected: {
        title: 'Цель достигнута',
        body: 'Цель «Резервный фонд» достигнута.',
        actionUrl: '/goals',
      },
    },
    {
      source: 'tafel',
      type: 'tafel.task.due.v1',
      payload: { recipientId: 'user-1', taskTitle: 'Опубликовать релиз', dueDate: '2026-08-08', overdue: false },
      expected: {
        title: 'Срок задачи приближается',
        body: 'Задачу «Опубликовать релиз» нужно выполнить до 2026-08-08.',
        actionUrl: '/tasks',
      },
    },
    {
      source: 'tafel',
      type: 'tafel.task.due.v1',
      payload: { recipientId: 'user-1', taskTitle: 'Опубликовать релиз', dueDate: '2026-08-06', overdue: true },
      expected: {
        title: 'Задача просрочена',
        body: 'Срок задачи «Опубликовать релиз» истёк 2026-08-06.',
        actionUrl: '/tasks',
      },
    },
    {
      source: 'zettel',
      type: 'zettel.note.backlink_added.v1',
      payload: { recipientId: 'user-1', sourceTitle: 'Архитектура', targetTitle: 'Glocke' },
      expected: {
        title: 'Добавлена обратная ссылка',
        body: 'Заметка «Архитектура» теперь ссылается на «Glocke».',
        actionUrl: null,
      },
    },
  ])('centrally renders $type in deterministic Russian', async ({ source, type, payload, expected }) => {
    const envelope = eventEnvelope({ source, type, payload })
    repository.seedInbox(inboxRecord({ envelope, source }))

    expect(await processor().processNext()).toBe('processed')
    expect(repository.notifications[0]).toMatchObject(expected)
  })

  it('never renders producer-controlled presentation or links', async () => {
    const envelope = eventEnvelope({
      source: 'kuvert',
      type: 'kuvert.goal.completed.v1',
      payload: {
        recipientId: 'user-1',
        goalName: 'Резервный фонд',
        title: 'Поддельный заголовок',
        body: 'Поддельный текст',
        actionUrl: 'https://attacker.invalid/collect',
      },
    })
    repository.seedInbox(inboxRecord({ envelope, source: 'kuvert' }))

    expect(await processor().processNext()).toBe('processed')
    expect(repository.notifications[0]).toMatchObject({
      title: 'Цель достигнута',
      body: 'Цель «Резервный фонд» достигнута.',
      actionUrl: '/goals',
    })
  })

  it.each([
    {
      case: 'unsupported type',
      envelope: eventEnvelope({ type: 'tafel.task.legacy.v0' }),
      source: 'tafel',
    },
    {
      case: 'type owned by another source',
      envelope: eventEnvelope({ source: 'kuvert', type: 'tafel.task.due.v1' }),
      source: 'kuvert',
    },
    {
      case: 'malformed registered payload',
      envelope: eventEnvelope({ payload: { recipientId: 'user-1', taskTitle: 'Старая задача' } }),
      source: 'tafel',
    },
  ])('settles a persisted $case and continues to a later valid event', async ({ envelope, source }) => {
    repository.seedInbox(inboxRecord({
      eventId: '10000000-0000-4000-8000-000000000010',
      envelope: { ...envelope, id: '10000000-0000-4000-8000-000000000010' },
      source,
    }))
    repository.seedInbox(inboxRecord({
      eventId: '10000000-0000-4000-8000-000000000011',
      envelope: eventEnvelope({ id: '10000000-0000-4000-8000-000000000011' }),
    }))
    const resolved: string[] = []
    const worker = createProcessor({
      repository,
      resolveRecipient: async (userId) => {
        resolved.push(userId)
        return { userId, notifyInApp: true, notifyBrowserPush: false }
      },
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createId: () => 'notification-valid',
      createLeaseId: () => crypto.randomUUID(),
    })

    expect(await worker.processNext()).toBe('processed')
    expect(repository.inbox[0]).toMatchObject({ status: 'processed', leaseId: null })
    expect(repository.notifications).toHaveLength(0)
    expect(resolved).toEqual([])

    expect(await worker.processNext()).toBe('processed')
    expect(repository.inbox[1]).toMatchObject({ status: 'processed', leaseId: null })
    expect(repository.notifications).toEqual([
      expect.objectContaining({ id: 'notification-valid', eventId: '10000000-0000-4000-8000-000000000011' }),
    ])
    expect(resolved).toEqual(['user-1'])
  })

  it('uses trusted source origins for Kuvert and Tafel actions while keeping password settings local', async () => {
    const envelopes = [
      eventEnvelope({
        id: '10000000-0000-4000-8000-000000000020',
        source: 'kuvert',
        type: 'kuvert.goal.completed.v1',
        payload: { recipientId: 'user-1', goalName: 'Резервный фонд' },
      }),
      eventEnvelope({ id: '10000000-0000-4000-8000-000000000021' }),
      eventEnvelope({
        id: '10000000-0000-4000-8000-000000000022',
        source: 'schlussel',
        type: 'schlussel.security.password_changed.v1',
        payload: { recipientId: 'user-1' },
      }),
    ]
    for (const envelope of envelopes) repository.seedInbox(inboxRecord({ envelope }))
    let notificationIndex = 0
    const worker = createProcessor({
      repository,
      resolveRecipient: async (userId) => ({ userId, notifyInApp: true, notifyBrowserPush: false }),
      sourceOrigins: {
        kuvert: 'https://kuvert.example.test',
        tafel: 'https://tafel.example.test',
      },
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createId: () => `notification-${notificationIndex += 1}`,
      createLeaseId: () => crypto.randomUUID(),
    })

    expect(await worker.processNext()).toBe('processed')
    expect(await worker.processNext()).toBe('processed')
    expect(await worker.processNext()).toBe('processed')
    expect(repository.notifications.map(({ source, actionUrl }) => ({ source, actionUrl }))).toEqual([
      { source: 'kuvert', actionUrl: 'https://kuvert.example.test/goals' },
      { source: 'tafel', actionUrl: 'https://tafel.example.test/tasks' },
      { source: 'schlussel', actionUrl: '/settings' },
    ])
  })

  it('renders a relative action URL when the producing service has no configured source origin (e.g. disabled in this deployment)', async () => {
    const envelope = eventEnvelope({
      id: '10000000-0000-4000-8000-000000000023',
      source: 'kuvert',
      type: 'kuvert.goal.completed.v1',
      payload: { recipientId: 'user-1', goalName: 'Резервный фонд' },
    })
    repository.seedInbox(inboxRecord({ envelope }))
    const worker = createProcessor({
      repository,
      resolveRecipient: async (userId) => ({ userId, notifyInApp: true, notifyBrowserPush: false }),
      sourceOrigins: { tafel: 'https://tafel.example.test' },
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createId: () => 'notification-no-origin',
      createLeaseId: () => crypto.randomUUID(),
    })

    expect(await worker.processNext()).toBe('processed')
    expect(repository.notifications).toEqual([
      expect.objectContaining({ source: 'kuvert', actionUrl: '/goals' }),
    ])
  })
})
