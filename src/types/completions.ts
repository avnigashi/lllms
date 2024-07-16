import type { SomeJSONSchema } from 'ajv/dist/types/json-schema'

export type CompletionFinishReason =
	| 'maxTokens'
	| 'toolCalls'
	| 'eogToken'
	| 'stopTrigger'
	| 'abort'
	| 'cancel'
	| 'timeout'


export interface AssistantToolCall {
	id: string
	name: string
	parameters?: Record<string, any>
}

export type ChatMessage = UserMessage | SystemMessage | AssistantMessage | ToolCallResultMessage

export interface MessageTextContentPart {
	type: 'text'
	text: string
}

export interface MessageImageContentPart {
	type: 'image'
	url: string
}

export type MessageContentPart = MessageTextContentPart | MessageImageContentPart

export interface UserMessage {
	role: 'user'
	content: string | MessageContentPart[]
	// content: string
}

export interface SystemMessage {
	role: 'system'
	content: string | MessageContentPart[]
}

export interface AssistantMessage {
	role: 'assistant'
	content: string
	toolCalls?: AssistantToolCall[]
}

export interface ToolCallResultMessage {
	role: 'tool'
	content: string | MessageContentPart[]
	callId: string
	// name: string
}

// TODO figure out how to type this better.
// export type ToolDefinitionParams<TParams = any> = JSONSchemaType<TParams>
export type ToolDefinitionParams<TParams> = SomeJSONSchema

export interface ToolDefinition<TParams extends Record<string, any> = any> {
	description?: string
	parameters?: ToolDefinitionParams<TParams>
	handler?: (params: TParams) => Promise<string>
}

export interface TextCompletionParams {
	temperature?: number
	maxTokens?: number
	seed?: number
	stop?: string[]
	repeatPenalty?: number
	repeatPenaltyNum?: number
	frequencyPenalty?: number
	presencePenalty?: number
	grammar?: string
	topP?: number
	minP?: number
	topK?: number
	tokenBias?: Record<string, number>
}

export interface ChatPreloadOptions {
	messages: ChatMessage[]
	toolDocumentation?: boolean
}

export interface PromptPrefixPreloadOptions {
	prefix: string
}

export type TextCompletionPreloadOptions = ChatPreloadOptions | PromptPrefixPreloadOptions