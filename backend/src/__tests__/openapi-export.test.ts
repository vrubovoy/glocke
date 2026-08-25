import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../openapi.js'

describe('export OpenAPI contract', () => {
  it('documents normal and delegated authentication for GET /exports/me', () => {
    const operation = openApiDocument.paths?.['/exports/me']?.get as any

    expect(operation).toBeDefined()
    expect(operation.security).toEqual(expect.arrayContaining([
      { bearerAuth: [] },
      { exportDelegationAuth: [] },
    ]))
    expect(operation.description).toMatch(/direct|normal/i)
    expect(operation.description).toMatch(/delegat/i)
    expect(operation.responses).toHaveProperty('401')

    expect(openApiDocument.components?.securitySchemes?.exportDelegationAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
  })

  it('publishes the versioned Glocke envelope and complete notification schema', () => {
    const operation = openApiDocument.paths?.['/exports/me']?.get as any
    expect(operation).toBeDefined()
    const schema = operation.responses['200'].content['application/json'].schema

    expect(schema.required).toEqual(expect.arrayContaining(['version', 'service', 'exportedAt', 'data']))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.version).toMatchObject({ type: 'string', enum: ['1'] })
    expect(schema.properties.service).toMatchObject({ type: 'string', enum: ['glocke'] })
    expect(schema.properties.exportedAt).toMatchObject({ type: 'string', format: 'date-time' })
    expect(schema.properties.data.required).toContain('notifications')
    expect(schema.properties.data.additionalProperties).toBe(false)

    const notifications = schema.properties.data.properties.notifications
    expect(notifications).toMatchObject({ type: 'array' })
    expect(notifications.items.additionalProperties).toBe(false)
    expect(notifications.items.required).toEqual(expect.arrayContaining([
      'id', 'eventId', 'source', 'type', 'title', 'body', 'actionUrl', 'createdAt', 'readAt',
    ]))
    expect(notifications.items.properties.readAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      nullable: true,
    })

    expect(schema.properties).not.toHaveProperty('inbox')
    expect(schema.properties.data.properties).not.toHaveProperty('inbox')
    expect(notifications.items.properties).not.toHaveProperty('userId')
    expect(notifications.items.properties).not.toHaveProperty('leaseId')
    expect(notifications.items.properties).not.toHaveProperty('payloadHash')
  })

  it('publishes source-bound notification and session-cleanup contracts', () => {
    const operation = openApiDocument.paths?.['/internal/v1/events']?.post as any
    const schema = operation.requestBody.content['application/json'].schema
    const variants = schema.oneOf ?? schema.anyOf

    expect(variants).toHaveLength(8)
    const contracts = Object.fromEntries(variants.map((variant: any) => [
      variant.properties.type.enum[0],
      variant,
    ]))
    expect(Object.keys(contracts).sort()).toEqual([
      'kuvert.debt.paid_off.v1',
      'kuvert.envelope.overdrawn.v1',
      'kuvert.goal.completed.v1',
      'schlussel.push.session_revoked.v1',
      'schlussel.security.password_changed.v1',
      'tafel.project.completed.v1',
      'tafel.task.due.v1',
      'zettel.note.backlink_added.v1',
    ])

    const expected = {
      'schlussel.security.password_changed.v1': ['recipientId'],
      'kuvert.goal.completed.v1': ['recipientId', 'goalName'],
      'kuvert.debt.paid_off.v1': ['recipientId', 'counterparty'],
      'kuvert.envelope.overdrawn.v1': ['recipientId', 'envelopeName'],
      'tafel.task.due.v1': ['recipientId', 'taskTitle', 'dueDate', 'overdue'],
      'tafel.project.completed.v1': ['recipientId', 'projectName'],
      'zettel.note.backlink_added.v1': ['recipientId', 'sourceTitle', 'targetTitle'],
    }
    for (const [type, fields] of Object.entries(expected)) {
      const variant = contracts[type]
      expect(variant.additionalProperties).toBe(false)
      expect(variant.properties.source.enum).toEqual([type.split('.')[0]])
      expect(variant.properties.payload.required.sort()).toEqual([...fields].sort())
      expect(variant.properties.payload.additionalProperties).toBe(false)
      expect(variant.properties.payload.properties).not.toHaveProperty('title')
      expect(variant.properties.payload.properties).not.toHaveProperty('body')
      expect(variant.properties.payload.properties).not.toHaveProperty('actionUrl')
      for (const field of fields.filter((field) => field !== 'overdue' && field !== 'dueDate')) {
        expect(variant.properties.payload.properties[field]).toMatchObject({
          type: 'string', minLength: 1, maxLength: 4_000,
        })
      }
    }
    expect(contracts['tafel.task.due.v1'].properties.payload.properties.dueDate).toMatchObject({
      type: 'string', format: 'date',
    })
    expect(contracts['tafel.task.due.v1'].properties.payload.properties.overdue).toMatchObject({ type: 'boolean' })
  })

  it('documents every current-browser Push operation and correlation input', () => {
    const status = openApiDocument.paths?.['/notifications/push/status']?.get as any
    const put = openApiDocument.paths?.['/notifications/push/subscriptions']?.put as any
    const remove = openApiDocument.paths?.['/notifications/push/subscriptions/{id}']?.delete as any

    expect(status.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'endpointHash', in: 'query' }),
    ]))
    expect(status.responses['200'].content['application/json'].schema.properties).toHaveProperty('currentSubscription')
    expect(put.requestBody.content['application/json'].schema.properties).toHaveProperty('expirationTime')
    expect(remove.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'endpointHash', in: 'query', required: true }),
    ]))
  })
})
