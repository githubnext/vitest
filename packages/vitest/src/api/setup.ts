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
import type { ParserOptions } from '@babel/parser'
import babelParser from '@babel/parser'
import babelTypes from '@babel/types'
import babelGenerator from '@babel/generator'
import { API_PATH } from '../constants'
import type { Vitest } from '../node'
import type { File, ModuleGraphData, Reporter, TaskResultPack, UserConsoleLog } from '../types'
import { getModuleGraph, isPrimitive, noop, stringifyReplace } from '../utils'
import type { WorkspaceProject } from '../node/workspace'
import { parseErrorStacktrace } from '../utils/source-map'
import type { CellOutput, TransformResultWithSource, WebSocketEvents, WebSocketHandlers } from './types'

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

  function rewriteCode(code: string, language: string) {
    const plugins = ((): ParserOptions['plugins'] => {
      switch (language) {
        case 'typescriptreact': return ['typescript', 'jsx']
        case 'typescript': return ['typescript']
        case 'javascriptreact': return ['jsx']
        case 'javascript': return []
        default: throw new Error(`unknown language: ${language}`)
      }
    })()

    const ast = babelParser.parse(code, { sourceType: 'module', plugins })
    const body = ast.program.body
    const last = body[body.length - 1]
    if (last.type === 'ExpressionStatement') {
      const defaultExport = babelTypes.exportDefaultDeclaration(last.expression)
      body[body.length - 1] = defaultExport
    }
    return babelGenerator(ast).code
  }

  const cellRegex = /^\.(.+)-([a-zA-z0-9_-]{21})$/

  async function executeCell(id: string, path: string, cellId: string) {
    clients.forEach(async (client) => {
      await client.startCellExecution(path, cellId)
    })
    let data
    let mime
    try {
      let { default: result } = await runner.executeFile(id)
      if (result instanceof Promise)
        result = await result
      if (typeof result === 'object'
        && ('data' in result && typeof result.data === 'string')
        && ('mime' in result && typeof result.mime === 'string')
      ) {
        mime = result.mime
        data = result.data
      }
      else {
        mime = 'application/json'
        data = JSON.stringify(result)
      }
    }
    catch (e) {
      const err = e as Error
      const obj = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      }
      data = JSON.stringify(obj, undefined, '\t')
      mime = 'application/vnd.code.notebook.error'
    }
    const cellOutput: CellOutput = {
      items: data === undefined
        ? []
        : [
            { data: [...Buffer.from(data, 'utf8').values()], mime },
          ],
    }
    clients.forEach(async (client) => {
      await client.endCellExecution(path, cellId, cellOutput)
    })
  }

  function invalidateModule(id: string) {
    const mod = runner.moduleCache.get(id)
    runner.moduleCache.delete(id)

    const parsedPath = parsePath(id)
    const match = cellRegex.exec(parsedPath.name)
    if (match) {
      const [_, name, cellId] = match
      const path = join(parsedPath.dir, `${name}.tsnb`)
      executeCell(id, path, cellId)
    }

    for (const dep of mod.importers)
      invalidateModule(dep)
  }

  server.watcher.on('change', (id) => {
    invalidateModule(id)
  })

  server.watcher.on('add', (id) => {
    invalidateModule(id)
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
          fs.writeFile(cellPath, rewriteCode(code, language), 'utf-8')
        },
      },
      {
        post: msg => ws.send(msg),
        on: fn => ws.on('message', fn),
        eventNames: ['onUserConsoleLog', 'onFinished', 'onFinishedReportCoverage', 'onCollected', 'onCancel', 'onTaskUpdate', 'startCellExecution', 'endCellExecution'],
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
