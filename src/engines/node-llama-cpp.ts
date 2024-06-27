import { nanoid } from 'nanoid'
import {
	getLlama,
	LlamaOptions,
	LlamaChat,
	LlamaModel,
	LlamaContext,
	LlamaCompletion,
	LlamaLogLevel,
	TokenBias,
	Token,
	LlamaContextSequence,
	Llama,
	LlamaGrammar,
	ChatHistoryItem,
	LlamaChatResponse,
	ChatModelResponse,
	LlamaChatResponseFunctionCall,
	LlamaEmbeddingContext,
	defineChatSessionFunction,
	GbnfJsonSchema,
	ChatSessionModelFunction,
	LlamaTextJSON,
} from 'node-llama-cpp'
import { StopGenerationTrigger } from 'node-llama-cpp/dist/utils/StopGenerationDetector'
import {
	EngineChatCompletionResult,
	EngineCompletionResult,
	EngineCompletionContext,
	EngineChatCompletionContext,
	EngineContext,
	EngineOptionsBase,
	FunctionDefinition,
	FunctionCallResultMessage,
	AssistantMessage,
	EngineEmbeddingContext,
	EngineEmbeddingsResult,
	CompletionFinishReason,
	ChatMessage,
} from '#lllms/types/index.js'
import { LogLevels } from '#lllms/lib/logger.js'

// https://github.com/withcatai/node-llama-cpp/pull/105
// https://github.com/withcatai/node-llama-cpp/discussions/109

export interface LlamaCppOptions extends EngineOptionsBase {
	memLock?: boolean
}

interface LlamaCppInstance {
	model: LlamaModel
	context: LlamaContext
	chat?: LlamaChat
	chatHistory: ChatHistoryItem[]
	grammars: Record<string, LlamaGrammar>
	pendingFunctionCalls: Record<string, any>
	lastEvaluation?: LlamaChatResponse['lastEvaluation']
	embeddingContext?: LlamaEmbeddingContext
}

interface LlamaChatResult {
	responseText: string | null
	functionCalls?: LlamaChatResponseFunctionCall<any>[]
	stopReason: LlamaChatResponse['metadata']['stopReason']
}

function prepareGrammars(llama: Llama, grammarConfig: Record<string, string>) {
	const grammars: Record<string, LlamaGrammar> = {}
	for (const key in grammarConfig) {
		const grammar = new LlamaGrammar(llama, {
			grammar: grammarConfig[key],
			// printGrammar: true,
		})
		grammars[key] = grammar
	}
	return grammars
}

function createChatMessageArray(messages: ChatMessage[]): ChatHistoryItem[] {
	const items: ChatHistoryItem[] = []
	let systemPrompt: string | undefined
	for (const message of messages) {
		if (message.role === 'user') {
			items.push({
				type: 'user',
				text: message.content,
			})
		} else if (message.role === 'assistant') {
			items.push({
				type: 'model',
				response: [message.content],
			})
		} else if (message.role === 'system') {
			if (systemPrompt) {
				systemPrompt += '\n\n' + message.content
			} else {
				systemPrompt = message.content
			}
		}
	}

	if (systemPrompt) {
		items.unshift({
			type: 'system',
			text: systemPrompt,
		})
	}

	return items
}

export async function loadInstance(
	{ config, log }: EngineContext<LlamaCppOptions>,
	signal?: AbortSignal,
) {
	log(LogLevels.debug, 'Load Llama model', config.engineOptions)
	// takes "auto" | "metal" | "cuda" | "vulkan"
	const gpuSetting = (config.engineOptions?.gpu ??
		'auto') as LlamaOptions['gpu']
	const llama = await getLlama({
		gpu: gpuSetting,
		// forwarding llama logger
		logLevel: LlamaLogLevel.debug,
		logger: (level, message) => {
			if (level === LlamaLogLevel.warn) {
				log(LogLevels.warn, message)
			} else if (
				level === LlamaLogLevel.error ||
				level === LlamaLogLevel.fatal
			) {
				log(LogLevels.error, message)
			} else if (
				level === LlamaLogLevel.info ||
				level === LlamaLogLevel.debug
			) {
				log(LogLevels.verbose, message)
			}
		},
	})

	let grammars: Record<string, LlamaGrammar> = {}
	if (config.grammars) {
		grammars = prepareGrammars(llama, config.grammars)
	}

	const model = await llama.loadModel({
		modelPath: config.file, // full model absolute path
		loadSignal: signal,
		useMlock: config.engineOptions?.memLock ?? false,
		gpuLayers: config.engineOptions?.gpuLayers,
		// onLoadProgress: (percent) => {}
	})

	const context = await model.createContext({
		sequences: 1,
		seed: createSeed(0, 1000000),
		threads: config.engineOptions?.cpuThreads,
		batchSize: config.engineOptions?.batchSize,
		contextSize: config.contextSize,
		// batching: {
		// 	dispatchSchedule: 'nextTick',
		// 	itemPrioritizationStrategy: 'maximumParallelism',
		// 	itemPrioritizationStrategy: 'firstInFirstOut',
		// },
		createSignal: signal,
	})

	const instance: LlamaCppInstance = {
		model,
		context,
		grammars,
		chat: undefined,
		chatHistory: [],
		pendingFunctionCalls: {},
		lastEvaluation: undefined,
	}

	if (config.preload) {
		// preloading chat session
		if ('messages' in config.preload) {
			const initialChatHistory = createChatMessageArray(config.preload.messages)
			const chat = new LlamaChat({
				contextSequence: context.getSequence(),
			})

			let inputFunctions: Record<string, ChatSessionModelFunction> | undefined
			if (config.functions && Object.keys(config.functions).length > 0) {
				inputFunctions = {}
				for (const functionName in config.functions) {
					const functionDef = config.functions[functionName]
					inputFunctions[functionName] = defineChatSessionFunction({
						description: functionDef.description,
						params: functionDef.parameters as GbnfJsonSchema,
						handler: functionDef.handler || (() => {}),
					}) as ChatSessionModelFunction
				}
			}

			const preloadRes = await chat.loadChatAndCompleteUserMessage(
				initialChatHistory,
				{
					initialUserPrompt: '',
					functions: inputFunctions,
					documentFunctionParams: config.preload.documentFunctions,
				},
			)

			instance.chat = chat
			instance.chatHistory = initialChatHistory
			instance.lastEvaluation = {
				cleanHistory: initialChatHistory,
				contextWindow: preloadRes.lastEvaluation.contextWindow,
				contextShiftMetadata: preloadRes.lastEvaluation.contextShiftMetadata,
			}
		}

		if ('prefix' in config.preload) {
			// TODO preloading completion prefix
			// context.getSequence()
			// const completion = new LlamaCompletion({
			// 	contextSequence: context.getSequence(),
			// })
			// const tokens = model.tokenize(config.preload.prefix)
			// await completion.generateCompletion(tokens, {
			// 	maxTokens: 0,
			// })
			// completion.dispose()
		}
	}

	return instance
}

export async function disposeInstance(instance: LlamaCppInstance) {
	instance.model.dispose()
}

function createSeed(min: number, max: number) {
	min = Math.ceil(min)
	max = Math.floor(max)
	return Math.floor(Math.random() * (max - min)) + min
}

function addFunctionCallToChatHistory({
	chatHistory,
	functionName,
	functionDescription,
	callParams,
	callResult,
	rawCall,
}: {
	chatHistory: ChatHistoryItem[]
	functionName: string
	functionDescription?: string
	callParams: any
	callResult: any
	rawCall?: LlamaTextJSON
}) {
	const newChatHistory = chatHistory.slice()
	if (
		newChatHistory.length === 0 ||
		newChatHistory[newChatHistory.length - 1].type !== 'model'
	)
		newChatHistory.push({
			type: 'model',
			response: [],
		})

	const lastModelResponseItem = newChatHistory[
		newChatHistory.length - 1
	] as ChatModelResponse
	const newLastModelResponseItem = { ...lastModelResponseItem }
	newChatHistory[newChatHistory.length - 1] = newLastModelResponseItem

	const modelResponse = newLastModelResponseItem.response.slice()
	newLastModelResponseItem.response = modelResponse

	modelResponse.push({
		type: 'functionCall',
		name: functionName,
		description: functionDescription,
		params: callParams,
		result: callResult,
		rawCall,
	})

	return newChatHistory
}

export async function processChatCompletion(
	instance: LlamaCppInstance,
	{
		request,
		config,
		resetContext,
		log,
		onChunk,
	}: EngineChatCompletionContext<LlamaCppOptions>,
	signal?: AbortSignal,
): Promise<EngineChatCompletionResult> {
	if (!instance.chat || resetContext) {
		// if context reset is requested, dispose the chat instance
		if (instance.chat) {
			await instance.chat.dispose()
		}
		instance.chat = new LlamaChat({
			contextSequence: instance.context.getSequence(),
		})
		// reset state and reingest the conversation history
		instance.lastEvaluation = undefined
		instance.pendingFunctionCalls = {}
		instance.chatHistory = createChatMessageArray(request.messages)
		// drop last user message. its gonna be added later, after resolved function calls
		if (instance.chatHistory[instance.chatHistory.length - 1].type === 'user') {
			instance.chatHistory.pop()
		}
	}

	// set additional stop generation triggers for this completion
	const customStopTriggers: StopGenerationTrigger[] = []
	const stopTrigger = request.stop ?? config.completionDefaults?.stop
	if (stopTrigger) {
		customStopTriggers.push(...stopTrigger.map((t) => [t]))
	}
	// setting up logit/token bias dictionary
	let tokenBias: TokenBias | undefined
	const completionTokenBias =
		request.tokenBias ?? config.completionDefaults?.tokenBias
	if (completionTokenBias) {
		tokenBias = new TokenBias(instance.model)
		for (const key in completionTokenBias) {
			const bias = completionTokenBias[key] / 10
			const tokenId = parseInt(key) as Token
			if (!isNaN(tokenId)) {
				tokenBias.set(tokenId, bias)
			} else {
				tokenBias.set(key, bias)
			}
		}
	}

	// setting up available function definitions
	const functionDefinitions: Record<string, FunctionDefinition> = {
		...config.functions,
		...request.functions,
	}

	// see if the user submitted any function call results
	const resolvedFunctionCalls = []
	const functionCallResultMessages = request.messages.filter(
		(m) => m.role === 'function',
	) as FunctionCallResultMessage[]
	for (const message of functionCallResultMessages) {
		if (instance.pendingFunctionCalls[message.callId]) {
			log(LogLevels.debug, 'Resolving pending function call', message)
			const functionCall = instance.pendingFunctionCalls[message.callId]
			const functionDef = functionDefinitions[functionCall.functionName]
			resolvedFunctionCalls.push({
				name: functionCall.functionName,
				description: functionDef?.description,
				params: functionCall.params,
				result: message.content,
				raw:
					functionCall.raw +
					instance.chat.chatWrapper.generateFunctionCallResult(
						functionCall.functionName,
						functionCall.params,
						message.content,
					),
			})
			delete instance.pendingFunctionCalls[message.callId]
		} else {
			log(LogLevels.warn, 'Pending function call not found', message)
		}
	}
	if (resolvedFunctionCalls.length) {
		instance.chatHistory.push({
			type: 'model',
			response: resolvedFunctionCalls.map((call) => {
				return {
					type: 'functionCall',
					...call,
				}
			}),
		})
	}

	// add the new user message to the chat history
	let newUserMessage: string | undefined
	const lastMessage = request.messages[request.messages.length - 1]
	if (lastMessage.role === 'user') {
		newUserMessage = lastMessage.content
		if (newUserMessage) {
			instance.chatHistory.push({
				type: 'user',
				text: newUserMessage,
			})
		}
	}

	// only grammar or functions can be used, not both.
	// currently ignoring function definitions if grammar is provided

	let inputGrammar: LlamaGrammar | undefined
	let inputFunctions: Record<string, ChatSessionModelFunction> | undefined

	if (request.grammar) {
		if (!instance.grammars[request.grammar]) {
			throw new Error(`Grammar "${request.grammar}" not found.`)
		}
		inputGrammar = instance.grammars[request.grammar]
	} else if (Object.keys(functionDefinitions).length > 0) {
		inputFunctions = {}
		for (const functionName in functionDefinitions) {
			const functionDef = functionDefinitions[functionName]
			inputFunctions[functionName] = defineChatSessionFunction({
				description: functionDef.description,
				params: functionDef.parameters as GbnfJsonSchema,
				handler: functionDef.handler || (() => {}),
			}) as ChatSessionModelFunction
		}
	}

	const defaults = config.completionDefaults ?? {}
	let lastEvaluation: LlamaChatResponse['lastEvaluation'] | undefined =
		instance.lastEvaluation
	let newChatHistory = instance.chatHistory.slice()
	let newContextWindowChatHistory = !lastEvaluation?.contextWindow
		? undefined
		: instance.chatHistory.slice()

	if (instance.chatHistory[instance.chatHistory.length - 1].type !== 'model') {
		newChatHistory.push({
			type: 'model',
			response: [],
		})
		if (newContextWindowChatHistory) {
			newContextWindowChatHistory.push({
				type: 'model',
				response: [],
			})
		}
	}

	let completionResult: LlamaChatResult

	const inputTokenCountBefore =
		instance.chat.sequence.tokenMeter.usedInputTokens
	const outputTokenCountBefore =
		instance.chat.sequence.tokenMeter.usedOutputTokens

	const functionsOrGrammar = inputFunctions
		? {
				functions: inputFunctions,
				documentFunctionParams: true,
				maxParallelFunctionCalls: 2,
				onFunctionCall: async (
					functionCall: LlamaChatResponseFunctionCall<any>,
				) => {
					// log(LogLevels.debug, 'Called function', functionCall)
				},
		  }
		: {
				grammar: inputGrammar,
		}

	while (true) {
		const {
			functionCalls,
			lastEvaluation: currentLastEvaluation,
			metadata,
		} = await instance.chat.generateResponse(newChatHistory, {
			signal,
			maxTokens: request.maxTokens ?? defaults.maxTokens,
			temperature: request.temperature ?? defaults.temperature,
			topP: request.topP ?? defaults.topP,
			topK: request.topK ?? defaults.topK,
			minP: request.minP ?? defaults.minP,
			tokenBias,
			customStopTriggers,
			trimWhitespaceSuffix: false,
			stopOnAbortSignal: true,
			...functionsOrGrammar,
			repeatPenalty: {
				lastTokens: request.repeatPenaltyNum ?? defaults.repeatPenaltyNum,
				frequencyPenalty: request.frequencyPenalty ?? defaults.frequencyPenalty,
				presencePenalty: request.presencePenalty ?? defaults.presencePenalty,
			},
			contextShift: {
				// strategy: 'eraseFirstResponseAndKeepFirstSystem',
				lastEvaluationMetadata: lastEvaluation?.contextShiftMetadata,
			},
			lastEvaluationContextWindow: {
				history: newContextWindowChatHistory,
				minimumOverlapPercentageToPreventContextShift: 0.5,
			},
			onToken: (tokens) => {
				const text = instance.model.detokenize(tokens)
				if (onChunk) {
					onChunk({
						tokens,
						text,
					})
				}
			},
		})

		lastEvaluation = currentLastEvaluation
		newChatHistory = lastEvaluation.cleanHistory

		if (functionCalls) {
			// find leading immediately evokable function calls (=have a handler)
			const evokableFunctionCalls = []
			for (const functionCall of functionCalls) {
				const functionDef = functionDefinitions[functionCall.functionName]
				if (functionDef.handler) {
					evokableFunctionCalls.push(functionCall)
				} else {
					break
				}
			}

			// resolve their results.
			const results = await Promise.all(
				evokableFunctionCalls.map(async (functionCall) => {
					const functionDef = functionDefinitions[functionCall.functionName]
					if (!functionDef) {
						throw new Error(
							`The model tried to call undefined function "${functionCall.functionName}"`,
						)
					}
					const functionCallResult = await functionDef.handler!(
						functionCall.params,
					)
					log(LogLevels.debug, 'Function handler resolved', {
						functionName: functionCall.functionName,
						functionParams: functionCall.params,
						functionResult: functionCallResult,
					})
					return {
						functionDef,
						functionCall,
						functionCallResult,
					}
				}),
			)
			newContextWindowChatHistory = lastEvaluation.contextWindow

			// add results to chat history in the order they were called
			for (const callResult of results) {
				newChatHistory = addFunctionCallToChatHistory({
					chatHistory: newChatHistory,
					functionName: callResult.functionCall.functionName,
					functionDescription: callResult.functionDef.description,
					callParams: callResult.functionCall.params,
					callResult: callResult.functionCallResult,
					rawCall: callResult.functionCall.raw,
				})
				newContextWindowChatHistory = addFunctionCallToChatHistory({
					chatHistory: newChatHistory,
					functionName: callResult.functionCall.functionName,
					functionDescription: callResult.functionDef.description,
					callParams: callResult.functionCall.params,
					callResult: callResult.functionCallResult,
					rawCall: callResult.functionCall.raw,
				})
			}

			// check if all function calls were immediately evokable
			const remainingFunctionCalls = functionCalls.slice(
				evokableFunctionCalls.length,
			)

			if (remainingFunctionCalls.length === 0) {
				// if yes, continue with generation
				lastEvaluation.cleanHistory = newChatHistory
				lastEvaluation.contextWindow = newContextWindowChatHistory!
				continue
			} else {
				// if no, return the function calls and skip generation
				completionResult = {
					responseText: null,
					stopReason: 'functionCalls',
					functionCalls: remainingFunctionCalls,
				}
				break
			}
		}

		// no function calls happened, we got a model response.
		instance.lastEvaluation = lastEvaluation
		instance.chatHistory = newChatHistory
		const lastMessage = instance.chatHistory[
			instance.chatHistory.length - 1
		] as ChatModelResponse
		const responseText = lastMessage.response
			.filter((item: any) => typeof item === 'string')
			.join('')
		completionResult = {
			responseText,
			stopReason: metadata.stopReason,
		}
		break
	}

	const assistantMessage: AssistantMessage = {
		role: 'assistant',
		content: completionResult.responseText || '',
	}

	if (completionResult.functionCalls) {
		// TODO its possible that there are tailing immediately-evaluatable function calls.
		// as is, these may never resolve
		const pendingFunctionCalls = completionResult.functionCalls.filter(
			(call) => {
				const functionDef = functionDefinitions[call.functionName]
				return !functionDef.handler
			},
		)

		assistantMessage.functionCalls = pendingFunctionCalls.map((call) => {
			const callId = nanoid()
			instance.pendingFunctionCalls[callId] = call
			log(LogLevels.debug, 'Adding pending function call result', call)
			return {
				id: callId,
				name: call.functionName,
				parameters: call.params,
			}
		})
	}

	const inputTokenCountAfter = instance.chat.sequence.tokenMeter.usedInputTokens
	const outputTokenCountAfter =
		instance.chat.sequence.tokenMeter.usedOutputTokens
	const promptTokens = inputTokenCountAfter - inputTokenCountBefore
	const completionTokens = outputTokenCountAfter - outputTokenCountBefore
	return {
		finishReason: mapFinishReason(completionResult.stopReason),
		message: assistantMessage,
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
	}
}

function mapFinishReason(
	nodeLlamaCppFinishReason: string,
): CompletionFinishReason {
	switch (nodeLlamaCppFinishReason) {
		case 'functionCalls':
			return 'functionCall'
		case 'stopGenerationTrigger':
			return 'stopTrigger'
		case 'customStopTrigger':
			return 'stopTrigger'
		default:
			return nodeLlamaCppFinishReason as CompletionFinishReason
	}
}

export async function processCompletion(
	instance: LlamaCppInstance,
	{ request, config, log, onChunk }: EngineCompletionContext<LlamaCppOptions>,
	signal?: AbortSignal,
): Promise<EngineCompletionResult> {
	if (!request.prompt) {
		throw new Error('Prompt is required for completion.')
	}

	let contextSequence: LlamaContextSequence
	if (instance.context.sequencesLeft) {
		log(LogLevels.debug, 'Clearing history', {
			sequencesLeft: instance.context.sequencesLeft,
		})
		contextSequence = instance.context.getSequence()
		await contextSequence.clearHistory()
	} else {
		log(LogLevels.debug, 'No sequencesLeft, recreating context')
		await instance.context.dispose()
		instance.context = await instance.model.createContext({
			createSignal: signal,
			seed: request.seed ?? config.completionDefaults?.seed, // || createSeed(0, 1000000),
			threads: config.engineOptions?.cpuThreads,
			batchSize: config.engineOptions?.batchSize,
		})
		contextSequence = instance.context.getSequence()
	}

	const completion = new LlamaCompletion({
		contextSequence: contextSequence,
	})

	const stopGenerationTriggers: StopGenerationTrigger[] = []
	const stopTrigger = request.stop ?? config.completionDefaults?.stop
	if (stopTrigger) {
		stopGenerationTriggers.push(...stopTrigger.map((t) => [t]))
	}

	const tokens = instance.model.tokenize(request.prompt)
	const defaults = config.completionDefaults ?? {}
	let generatedTokenCount = 0
	const result = await completion.generateCompletionWithMeta(tokens, {
		maxTokens: request.maxTokens ?? defaults.maxTokens,
		temperature: request.temperature ?? defaults.temperature,
		topP: request.topP ?? defaults.topP,
		topK: request.topK ?? defaults.topK,
		minP: request.minP ?? defaults.minP,
		repeatPenalty: {
			lastTokens: request.repeatPenaltyNum ?? defaults.repeatPenaltyNum,
			frequencyPenalty: request.frequencyPenalty ?? defaults.frequencyPenalty,
			presencePenalty: request.presencePenalty ?? defaults.presencePenalty,
		},
		signal: signal,
		customStopTriggers: stopGenerationTriggers.length
			? stopGenerationTriggers
			: undefined,
		onToken: (tokens) => {
			generatedTokenCount += tokens.length
			const text = instance.model.detokenize(tokens)
			if (onChunk) {
				onChunk({
					tokens,
					text,
				})
			}
		},
	})

	completion.dispose()

	return {
		finishReason: mapFinishReason(result.metadata.stopReason),
		text: result.response,
		promptTokens: tokens.length,
		completionTokens: generatedTokenCount,
		totalTokens: tokens.length + generatedTokenCount,
	}
}

export async function processEmbeddings(
	instance: LlamaCppInstance,
	{ request, config }: EngineEmbeddingContext<LlamaCppOptions>,
	signal?: AbortSignal,
): Promise<EngineEmbeddingsResult> {
	const texts: string[] = []
	if (typeof request.input === 'string') {
		texts.push(request.input)
	} else {
		const strInputs = request.input.filter(
			(i) => typeof i === 'string',
		) as string[]
		texts.push(...strInputs)
	}

	if (!instance.embeddingContext) {
		// console.debug('creating embed context')
		instance.embeddingContext = await instance.model.createEmbeddingContext()
	}

	const embeddings: Float32Array[] = []
	let inputTokens = 0

	for (const text of texts) {
		const tokenizedInput = instance.model.tokenize(text)
		inputTokens += tokenizedInput.length
		const embedding = await instance.embeddingContext.getEmbeddingFor(
			tokenizedInput,
		)
		embeddings.push(new Float32Array(embedding.vector))
	}

	return {
		embeddings,
		inputTokens,
	}
}
