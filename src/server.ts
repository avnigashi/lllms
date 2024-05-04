import http from 'node:http'
import { ListenOptions } from 'node:net'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { LLMPool } from '#lllms/pool.js'
import { LLMInstance } from '#lllms/instance.js'
import { ModelDownloader } from '#lllms/downloader.js'
import { LLMOptions, LLMRequest } from '#lllms/types/index.js'
import { createOpenAIRequestHandlers } from '#lllms/api/openai/index.js'
import { createAPIMiddleware } from '#lllms/api/v1/index.js'
import { resolveModelConfig } from '#lllms/lib/resolveModelConfig.js'
import { Logger, LogLevel, LogLevels, createLogger } from '#lllms/lib/logger.js'

export interface LLMServerOptions {
	concurrency?: number
	modelsDir?: string
	logger?: Logger
	models: Record<string, LLMOptions>
}

export class LLMServer {
	pool: LLMPool
	loader: ModelDownloader
	logger: Logger
	modelsDir: string
	constructor(opts: LLMServerOptions) {
		this.logger = opts.logger ?? createLogger(LogLevels.warn)
		this.modelsDir =
			opts.modelsDir || path.resolve(os.homedir(), '.cache/lllms')
		const poolModels = resolveModelConfig(opts.models, this.modelsDir)
		this.pool = new LLMPool(
			{
				concurrency: opts.concurrency ?? 1,
				logger: this.logger,
				models: poolModels,
			},
			this.prepareInstance.bind(this),
		)
		this.loader = new ModelDownloader()
	}

	async start() {
		await fs.mkdir(this.modelsDir, { recursive: true })
		await this.pool.init()
	}
	
	async requestLLM(request: LLMRequest) {
		return this.pool.requestLLM(request)
	}

	// gets called by the pool right before a new instance is created
	async prepareInstance(instance: LLMInstance, signal?: AbortSignal) {
		// make sure the model files exists, download if possible.
		const config = instance.config
		if (!existsSync(config.file) && config.url) {
			await this.loader.enqueueDownload(
				{
					file: config.file,
					url: config.url,
				},
				signal,
			)
		}
		if (!existsSync(config.file)) {
			throw new Error(`Model file not found: ${config.file}`)
		}

		// TODO good place to validate the model file, if necessary
	}

	async stop() {
		// TODO need to do more cleanup here
		this.pool.queue.clear()
		await this.pool.queue.onIdle()
		await this.pool.dispose()
	}

	getStatus() {
		const pool = this.pool.getStatus()
		return {
			downloads: {
				queue: this.loader.queue.size,
				pending: this.loader.queue.pending,
				tasks: this.loader.tasks,
			},
			pool,
		}
	}
}

export function startLLMs(opts: LLMServerOptions) {
	const server = new LLMServer(opts)
	server.start()
	return server
}

export function createOpenAIMiddleware(llmServer: LLMServer) {
	const router = express.Router()
	const requestHandlers = createOpenAIRequestHandlers(llmServer.pool)
	router.get('/v1/models', requestHandlers.listModels)
	router.post('/v1/completions', requestHandlers.completions)
	router.post('/v1/chat/completions', requestHandlers.chatCompletions)
	return router
}

export function createExpressMiddleware(llmServer: LLMServer) {
	const router = express.Router()
	router.get('/', (req, res) => {
		res.json(llmServer.getStatus())
	})
	router.use('/openai', createOpenAIMiddleware(llmServer))
	router.use('/llama', createAPIMiddleware(llmServer))
	return router
}

export interface StandaloneServerOptions extends LLMServerOptions {
	listen?: ListenOptions
	logLevel?: LogLevel
}

export async function serveLLMs(opts: StandaloneServerOptions) {
	const { listen, ...serverOpts } = opts
	const listenOpts = listen ?? { port: 3000 }
	const llmServer = new LLMServer({
		logger: createLogger(opts.logLevel || LogLevels.warn),
		...serverOpts,
	})

	const app = express()
	app.use(
		cors(),
		express.json({ limit: '50mb' }),
		createExpressMiddleware(llmServer),
	)

	app.set('json spaces', 2)
	const httpServer = http.createServer(app)

	httpServer.on('close', () => {
		llmServer.stop()
	})

	const initPromise = llmServer.start()
	const listenPromise = new Promise<void>((resolve) => {
		httpServer.listen(listenOpts, resolve)
	})
	await listenPromise
	// await Promise.all([listenPromise, llmServer.start()])
	return httpServer
}
