import { expect } from 'vitest'
import { LLMServer } from '#lllms/server.js'
import { ChatMessage, FunctionDefinition } from '#lllms/types/index.js'
import { createChatCompletion } from '../../util.js'

interface GetLocationWeatherParams {
	location: string
	unit?: 'celsius' | 'fahrenheit'
}

const getLocationWeather: FunctionDefinition<GetLocationWeatherParams> = {
	description: 'Get the weather in a location',
	parameters: {
		type: 'object',
		properties: {
			location: {
				type: 'string',
				description: 'The city and state, e.g. San Francisco, CA',
			},
			unit: {
				type: 'string',
				enum: ['celsius', 'fahrenheit'],
			},
		},
		required: ['location'],
	},
}

const getUserLocation = {
	description: 'Get the current user location',
	handler: async () => {
		return 'New York, New York, United States'
	},
}

export async function runFunctionCallTest(llms: LLMServer) {
	const messages: ChatMessage[] = [
		{
			role: 'user',
			content: "Where am I?",
		},
	]
	const turn1 = await createChatCompletion(llms, {
		functions: {
			getUserLocation,
		},
		messages,
	})
	expect(turn1.result.message.functionCalls).toBeUndefined()
	expect(turn1.result.message.content).toMatch(/New York/)
}

export async function runSequentialFunctionCallTest(llms: LLMServer) {
	const messages: ChatMessage[] = [
		{
			role: 'user',
			content: "What's the weather like today? (hint: combine functions!)",
		},
	]
	const turn1 = await createChatCompletion(llms, {
		functions: {
			getUserLocation,
			getLocationWeather,
		},
		messages,
	})
	expect(turn1.result.message.functionCalls).toBeDefined()
	expect(turn1.result.message.functionCalls!.length).toBe(1)

	const turn1FunctionCall = turn1.result.message.functionCalls![0]
	messages.push({
		callId: turn1FunctionCall.id,
		role: 'function',
		name: turn1FunctionCall.name,
		content: 'New York today: Cloudy, 21°, low chance of rain.',
	})
	const turn2 = await createChatCompletion(llms, {
		messages,
	})
	expect(turn2.result.message.content).toMatch(/cloudy/)
}

interface GetRandomNumberParams {
	min: number
	max: number
}

export async function runParallelFunctionCallTest(llms: LLMServer) {
	const generatedNumbers: number[] = []
	const getRandomNumber: FunctionDefinition<GetRandomNumberParams> = {
		description: 'Generate a random integer in given range',
		parameters: {
			type: 'object',
			properties: {
				min: {
					type: 'number',
				},
				max: {
					type: 'number',
				},
			},
		},
		handler: async (params) => {
			const num =
				Math.floor(Math.random() * (params.max - params.min + 1)) + params.min
			generatedNumbers.push(num)
			return num.toString()
		},
	}

	const turn1 = await createChatCompletion(llms, {
		functions: { getRandomNumber },
		messages: [
			{
				role: 'user',
				content: 'Roll the dice twice, then tell me the results.',
			},
		]
	})

	// console.debug({
	// 	turn1: turn1.result.message,
	// })
	expect(generatedNumbers.length).toBe(2)
	expect(turn1.result.message.content).toContain(generatedNumbers[0].toString())
	expect(turn1.result.message.content).toContain(generatedNumbers[1].toString())
}
