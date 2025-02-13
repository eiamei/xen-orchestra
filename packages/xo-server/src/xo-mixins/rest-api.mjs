import { every } from '@vates/predicates'
import { ifDef } from '@xen-orchestra/defined'
import { invalidCredentials, noSuchObject } from 'xo-common/api-errors.js'
import { pipeline } from 'stream'
import { json, Router } from 'express'
import createNdJsonStream from '../_createNdJsonStream.mjs'
import pick from 'lodash/pick.js'
import map from 'lodash/map.js'
import * as CM from 'complex-matcher'
import fromCallback from 'promise-toolbox/fromCallback'
import { VDI_FORMAT_RAW, VDI_FORMAT_VHD } from '@xen-orchestra/xapi'

function sendObjects(objects, req, res) {
  const { query } = req
  const basePath = req.baseUrl + req.path
  const makeUrl = object => basePath + '/' + object.id

  let { fields } = query
  let results
  if (fields !== undefined) {
    fields = fields.split(',')
    results = map(objects, object => {
      const url = makeUrl(object)
      object = pick(object, fields)
      object.href = url
      return object
    })
  } else {
    results = map(objects, makeUrl)
  }

  if (query.ndjson !== undefined) {
    res.set('Content-Type', 'application/x-ndjson')
    pipeline(createNdJsonStream(results), res, error => {
      if (error !== undefined) {
        console.warn('pipeline error', error)
      }
    })
  } else {
    res.json(results)
  }
}

const handleOptionalUserFilter = filter => filter && CM.parse(filter).createPredicate()

const subRouter = (app, path) => {
  const router = Router({ strict: true })
  app.use(path, router)
  return router
}

// wraps an async middleware
function wrap(middleware) {
  return async function asyncMiddlewareWrapped(req, res, next) {
    try {
      await middleware.apply(this, arguments)
    } catch (error) {
      next(error)
    }
  }
}

export default class RestApi {
  constructor(app, { express }) {
    // don't setup the API if express is not present
    //
    // that can happen when the app is instanciated in another context like xo-server-recover-account
    if (express === undefined) {
      return
    }

    const api = subRouter(express, '/rest/v0')

    api.use(({ cookies }, res, next) => {
      app.authenticateUser({ token: cookies.authenticationToken ?? cookies.token }).then(
        ({ user }) => {
          if (user.permission === 'admin') {
            return next()
          }

          res.sendStatus(401)
        },
        error => {
          if (invalidCredentials.is(error)) {
            res.sendStatus(401)
          } else {
            next(error)
          }
        }
      )
    })

    const types = [
      'host',
      'network',
      'pool',
      'SR',
      'VBD',
      'VDI-snapshot',
      'VDI',
      'VIF',
      'VM-snapshot',
      'VM-template',
      'VM',
    ]
    const collections = Object.fromEntries(
      types.map(type => {
        const id = type.toLocaleLowerCase() + 's'
        return [id, { id, isCorrectType: _ => _.type === type, type }]
      })
    )

    api.param('collection', (req, res, next) => {
      const id = req.params.collection
      const collection = collections[id]
      if (collection === undefined) {
        next('route')
      } else {
        req.collection = collection
        next()
      }
    })
    api.param('object', (req, res, next) => {
      const id = req.params.object
      const { type } = req.collection
      try {
        req.xapiObject = app.getXapiObject((req.xoObject = app.getObject(id, type)))
        next()
      } catch (error) {
        if (noSuchObject.is(error, { id, type })) {
          next('route')
        } else {
          next(error)
        }
      }
    })

    api.get('/', (req, res) => sendObjects(collections, req, res))
    api.get(
      '/:collection',
      wrap(async (req, res) => {
        const { query } = req
        sendObjects(
          await app.getObjects({
            filter: every(req.collection.isCorrectType, handleOptionalUserFilter(query.filter)),
            limit: ifDef(query.limit, Number),
          }),
          req,
          res
        )
      })
    )
    api.get('/:collection/:object', (req, res) => {
      res.json(req.xoObject)
    })
    api.patch(
      '/:collection/:object',
      json(),
      wrap(async (req, res) => {
        const obj = req.xapiObject

        const promises = []
        const { body } = req
        for (const key of ['name_description', 'name_label']) {
          const value = body[key]
          if (value !== undefined) {
            promises.push(obj['set_' + key](value))
          }
        }
        await promises
        res.sendStatus(200)
      })
    )

    api.post(
      '/srs/:object/vdis',
      wrap(async (req, res) => {
        const sr = req.xapiObject
        req.length = +req.headers['content-length']

        const { name_label, name_description, raw } = req.query
        const vdiRef = await sr.$importVdi(req, {
          format: raw !== undefined ? VDI_FORMAT_RAW : VDI_FORMAT_VHD,
          name_label,
          name_description,
        })

        res.end(await sr.$xapi.getField('VDI', vdiRef, 'uuid'))
      })
    )

    api.delete(
      '/:collection(vdis|vdi-snapshots|vms|vm-snapshots|vm-templates)/:object',
      wrap(async (req, res) => {
        await req.xapiObject.$destroy()
        res.sendStatus(200)
      })
    )

    api.get(
      '/:collection(vdis|vdi-snapshots)/:object.:format(vhd|raw)',
      wrap(async (req, res) => {
        const stream = await req.xapiObject.$exportContent({ format: req.params.format })

        stream.headers['content-disposition'] = 'attachment'
        res.writeHead(stream.statusCode, stream.statusMessage != null ? stream.statusMessage : '', stream.headers)

        await fromCallback(pipeline, stream, res)
      })
    )

    api.get(
      '/:collection(vms|vm-snapshots|vm-templates)/:object.xva',
      wrap(async (req, res) => {
        const stream = await req.xapiObject.$export({ compress: req.query.compress })

        stream.headers['content-disposition'] = 'attachment'
        res.writeHead(stream.statusCode, stream.statusMessage != null ? stream.statusMessage : '', stream.headers)

        await fromCallback(pipeline, stream, res)
      })
    )
  }
}
