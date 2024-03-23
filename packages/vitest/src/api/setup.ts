import { existsSync, promises as fs } from 'node:fs'

import { dirname, join, parse as parsePath } from 'pathe'
import type { BirpcReturn } from 'birpc'
import { createBirpc } from 'birpc'
import { parse, stringify } from 'flatted'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { isFileServingAllowed } from 'vite'
import type { ViteDevServer } from 'vite'
import type { StackTraceParserOptions } from '@vitest/utils/source-map'
import { ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { API_PATH } from '../constants'
import type { Vitest } from '../node'
import type { File, ModuleGraphData, Reporter, TaskResultPack, UserConsoleLog } from '../types'
import { getModuleGraph, isPrimitive, noop, stringifyReplace } from '../utils'
import type { WorkspaceProject } from '../node/workspace'
import { parseErrorStacktrace } from '../utils/source-map'
import type { TransformResultWithSource, WebSocketEvents, WebSocketHandlers } from './types'

export function setup(vitestOrWorkspace: Vitest | WorkspaceProject, _server?: ViteDevServer) {
  const ctx = 'ctx' in vitestOrWorkspace ? vitestOrWorkspace.ctx : vitestOrWorkspace

  const wss = new WebSocketServer({ noServer: true })

  const clients = new Map<WebSocket, BirpcReturn<WebSocketEvents, WebSocketHandlers>>()

  const server = _server || ctx.server

  const vitenode = new ViteNodeServer(server)
  const runner = new ViteNodeRunner({
    root: server.config.root,
    base: server.config.base,
    fetchModule(id: string) {
      return vitenode.fetchModule(id)
    },
    resolveId(id: string, importer?: string) {
      return vitenode.resolveId(id, importer)
    },
  })

  server.watcher.on('change', (id) => {
    runner.moduleCache.delete(id)
  })

  server.httpServer?.on('upgrade', (request, socket, head) => {
    if (!request.url)
      return

    const { pathname } = new URL(request.url, 'http://localhost')
    if (pathname !== API_PATH)
      return

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
      setupClient(ws)
    })
  })

  function checkFileAccess(path: string) {
    if (!isFileServingAllowed(path, server))
      throw new Error(`Access denied to "${path}". See Vite config documentation for "server.fs": https://vitejs.dev/config/server-options.html#server-fs-strict.`)
  }

  function setupClient(ws: WebSocket) {
    const rpc = createBirpc<WebSocketEvents, WebSocketHandlers>(
      {
        async onUnhandledError(error, type) {
          ctx.state.catchError(error, type)
        },
        async onCollected(files) {
          ctx.state.collectFiles(files)
          await ctx.report('onCollected', files)
        },
        async onTaskUpdate(packs) {
          ctx.state.updateTasks(packs)
          await ctx.report('onTaskUpdate', packs)
        },
        onAfterSuiteRun(meta) {
          ctx.coverageProvider?.onAfterSuiteRun(meta)
        },
        getFiles() {
          return ctx.state.getFiles()
        },
        getPaths() {
          return ctx.state.getPaths()
        },
        sendLog(log) {
          return ctx.report('onUserConsoleLog', log)
        },
        resolveSnapshotPath(testPath) {
          return ctx.snapshot.resolvePath(testPath)
        },
        resolveSnapshotRawPath(testPath, rawPath) {
          return ctx.snapshot.resolveRawPath(testPath, rawPath)
        },
        async readSnapshotFile(snapshotPath) {
          checkFileAccess(snapshotPath)
          if (!existsSync(snapshotPath))
            return null
          return fs.readFile(snapshotPath, 'utf-8')
        },
        async readTestFile(id) {
          if (!ctx.state.filesMap.has(id) || !existsSync(id))
            return null
          return fs.readFile(id, 'utf-8')
        },
        async saveTestFile(id, content) {
          if (!ctx.state.filesMap.has(id) || !existsSync(id))
            throw new Error(`Test file "${id}" was not registered, so it cannot be updated using the API.`)
          return fs.writeFile(id, content, 'utf-8')
        },
        async saveSnapshotFile(id, content) {
          checkFileAccess(id)
          await fs.mkdir(dirname(id), { recursive: true })
          return fs.writeFile(id, content, 'utf-8')
        },
        async removeSnapshotFile(id) {
          checkFileAccess(id)
          if (!existsSync(id))
            throw new Error(`Snapshot file "${id}" does not exist.`)
          return fs.unlink(id)
        },
        snapshotSaved(snapshot) {
          ctx.snapshot.add(snapshot)
        },
        async rerun(files) {
          await ctx.rerunFiles(files)
        },
        getConfig() {
          return vitestOrWorkspace.config
        },
        async getBrowserFileSourceMap(id) {
          if (!('ctx' in vitestOrWorkspace))
            return undefined
          const mod = vitestOrWorkspace.browser?.moduleGraph.getModuleById(id)
          return mod?.transformResult?.map
        },
        async getTransformResult(id) {
          const result: TransformResultWithSource | null | undefined = await ctx.vitenode.transformRequest(id)
          if (result) {
            try {
              result.source = result.source || (await fs.readFile(id, 'utf-8'))
            }
            catch {}
            return result
          }
        },
        async getModuleGraph(id: string): Promise<ModuleGraphData> {
          return getModuleGraph(ctx, id)
        },
        updateSnapshot(file?: File) {
          if (!file)
            return ctx.updateSnapshot()
          return ctx.updateSnapshot([file.filepath])
        },
        onCancel(reason) {
          ctx.cancelCurrentRun(reason)
        },
        debug(...args) {
          ctx.logger.console.debug(...args)
        },
        getCountOfFailedTests() {
          return ctx.state.getCountOfFailedTests()
        },
        getUnhandledErrors() {
          return ctx.state.getUnhandledErrors()
        },

        // TODO: have a separate websocket conection for private browser API
        getBrowserFiles() {
          if (!('ctx' in vitestOrWorkspace))
            throw new Error('`getBrowserTestFiles` is only available in the browser API')
          return vitestOrWorkspace.browserState?.files ?? []
        },
        finishBrowserTests() {
          if (!('ctx' in vitestOrWorkspace))
            throw new Error('`finishBrowserTests` is only available in the browser API')
          return vitestOrWorkspace.browserState?.resolve()
        },
        getProvidedContext() {
          return 'ctx' in vitestOrWorkspace ? vitestOrWorkspace.getProvidedContext() : ({} as any)
        },
        async executeCell(path, id, language, code) {
          try {
            const ext = (() => {
              switch (language) {
                case 'typescriptreact':
                  return 'tsx'
                case 'typescript':
                  return 'ts'
                case 'javascriptreact':
                  return 'jsx'
                case 'javascript':
                  return 'js'
                default:
                  throw new Error(`unknown language "${language}"`)
              }
            })()
            const parsedPath = parsePath(path)
            const cellPath = join(parsedPath.dir, `.${parsedPath.name}-${id}.${ext}`)
            await fs.writeFile(cellPath, code, 'utf-8')

            runner.moduleCache.delete(cellPath)
            const { default: result } = await runner.executeFile(cellPath)

            return Promise.resolve({
              items: [
                { data: [...Buffer.from(JSON.stringify(result), 'utf8')], mime: 'application/json' },
              ],
            })
          }
          catch (e) {
            const err = e as Error
            const obj = {
              name: err.name,
              message: err.message,
              stack: err.stack,
            }
            const json = JSON.stringify(obj, undefined, '\t')
            return Promise.resolve({
              items: [
                { data: [...Buffer.from(json, 'utf8').values()], mime: 'application/vnd.code.notebook.error' },
              ],
            })
          }
        },
      },
      {
        post: msg => ws.send(msg),
        on: fn => ws.on('message', fn),
        eventNames: ['onUserConsoleLog', 'onFinished', 'onFinishedReportCoverage', 'onCollected', 'onCancel', 'onTaskUpdate'],
        serialize: (data: any) => stringify(data, stringifyReplace),
        deserialize: parse,
        onTimeoutError(functionName) {
          throw new Error(`[vitest-api]: Timeout calling "${functionName}"`)
        },
      },
    )

    ctx.onCancel(reason => rpc.onCancel(reason))

    clients.set(ws, rpc)

    ws.on('close', () => {
      clients.delete(ws)
    })
  }

  ctx.reporters.push(new WebSocketReporter(ctx, wss, clients))
}

export class WebSocketReporter implements Reporter {
  constructor(
    public ctx: Vitest,
    public wss: WebSocketServer,
    public clients: Map<WebSocket, BirpcReturn<WebSocketEvents, WebSocketHandlers>>,
  ) {}

  onCollected(files?: File[]) {
    if (this.clients.size === 0)
      return
    this.clients.forEach((client) => {
      client.onCollected?.(files)?.catch?.(noop)
    })
  }

  async onTaskUpdate(packs: TaskResultPack[]) {
    if (this.clients.size === 0)
      return

    packs.forEach(([taskId, result]) => {
      const project = this.ctx.getProjectByTaskId(taskId)

      const parserOptions: StackTraceParserOptions = {
        getSourceMap: file => project.getBrowserSourceMapModuleById(file),
      }

      result?.errors?.forEach((error) => {
        if (!isPrimitive(error))
          error.stacks = parseErrorStacktrace(error, parserOptions)
      })
    })

    this.clients.forEach((client) => {
      client.onTaskUpdate?.(packs)?.catch?.(noop)
    })
  }

  onFinished(files?: File[], errors?: unknown[]) {
    this.clients.forEach((client) => {
      client.onFinished?.(files, errors)?.catch?.(noop)
    })
  }

  onFinishedReportCoverage() {
    this.clients.forEach((client) => {
      client.onFinishedReportCoverage?.()?.catch?.(noop)
    })
  }

  onUserConsoleLog(log: UserConsoleLog) {
    this.clients.forEach((client) => {
      client.onUserConsoleLog?.(log)?.catch?.(noop)
    })
  }
}
