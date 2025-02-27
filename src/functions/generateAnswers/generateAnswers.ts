import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { AzureOpenAI } from "openai";

// Initialize clients
const cosmosClient = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
const openAIClient = new AzureOpenAI({
	apiKey: process.env.OPENAI_KEY,
	endpoint: process.env.OPENAI_ENDPOINT,
	deployment: "gpt-35-turbo-16k",
	apiVersion: "2024-05-01-preview",
});

interface Player {
	id: string;
	gameId: string;
	prompt: string;
	screenName: string;
}

interface JudgeQuestion {
	id: string;
	content: string;
}

interface AIAnswer {
	id: string;
	gameId: string;
	playerId: string;
	playerName: string;
	questionId: string;
	question: string;
	assistantPrompt: string;
	answer: string;
	timestamp: string;
}

interface AIAnswerError {
	playerId: string;
	questionId: string;
	error: string;
	details?: string;
}

export async function generateAnswers(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	try {
		context.log(`Processing request for URL "${request.url}"`);

		// Get gameId from query parameter
		const gameId = request.query.get("gameId");
		if (!gameId) {
			return {
				status: 400,
				jsonBody: {
					error: "Missing gameId parameter",
				},
			};
		}

		// Get database and container references
		const database = cosmosClient.database("mini-prompt-quiz");
		const gameContainer = database.container("games");
		const playerContainer = database.container("players");

		//The judge exists on the game object. Fetch all the questions from the game object's judge
		const { resource: game } = await gameContainer
			.item(gameId, gameId)
			.read();
		if (!game) {
			return {
				status: 404,
				jsonBody: {
					error: "Game not found",
				},
			};
		}
		const judgeQuestions: JudgeQuestion[] = game.judge?.questions || [];
		if (judgeQuestions.length === 0) {
			return {
				status: 404,
				jsonBody: {
					error: "No judge questions found",
				},
			};
		}

		const playerQuery = `SELECT * FROM c WHERE c.gameId = @gameId`;

		// Fetch players for the specific gameId
		const playerRes = await playerContainer.items
			.query({
				query: playerQuery,
				parameters: [{ name: "@gameId", value: gameId }],
			})
			.fetchAll();

		// If no players are found, return
		if (playerRes.resources.length === 0) {
			return {
				status: 404,
				jsonBody: {
					error: "No players found for this game",
				},
			};
		}

		const players: Player[] = playerRes.resources;

		// Process each player's assistant with each judge question
		const aiResponses = await Promise.all(
			players.flatMap((player) =>
				judgeQuestions.map(async (judgeQ) => {
					try {
						// Sanitize inputs to help prevent content filter issues
						const sanitizedPrompt = sanitizeInput(
							player.prompt ?? ""
						);
						const sanitizedQuestion = sanitizeInput(judgeQ.content);

						// Combine the assistant's prompt with the judge's question using a more structured approach
						const combinedPrompt = createPrompt(
							sanitizedPrompt,
							sanitizedQuestion
						);

						// Add logging before making the API call
						context.log(
							`Sending request to OpenAI for player ${player.id} and question ${judgeQ.id}`
						);

						const response =
							await openAIClient.chat.completions.create({
								model: "gpt-35-turbo-16k",
								messages: [
									{
										role: "user",
										content: combinedPrompt,
									},
								],
								temperature: 0.7,
								max_tokens: 800,
							});

						// Check if we have a valid response
						if (
							!response ||
							!response.choices ||
							response.choices.length === 0
						) {
							context.log(
								`Empty response received for player ${player.id} and question ${judgeQ.id}`
							);
							return {
								playerId: player.id,
								questionId: judgeQ.id,
								error: "Empty response from AI service",
							} as AIAnswerError;
						}

						const answer =
							response.choices[0]?.message?.content || "";

						return {
							id: `${gameId}-${player.id}-${judgeQ.id}`,
							gameId: player.gameId,
							playerId: player.id,
							playerName: player.screenName || "Unknown Player",
							questionId: judgeQ.id,
							question: judgeQ.content,
							assistantPrompt: player.prompt,
							answer: answer,
							timestamp: new Date().toISOString(),
						} as AIAnswer;
					} catch (error) {
						const errorMessage =
							error instanceof Error
								? error.message
								: "Unknown error";
						context.error(
							`Error processing player ${player.id} with question ${judgeQ.id}: ${errorMessage}`
						);

						// Check if it's a content filter error
						const isContentFilterError =
							errorMessage.includes("content_filter") ||
							errorMessage.includes("content filter") ||
							errorMessage.includes("moderation");

						return {
							playerId: player.id,
							questionId: judgeQ.id,
							error: isContentFilterError
								? "Content filter triggered"
								: "Error generating response",
							details: errorMessage,
						} as AIAnswerError;
					}
				})
			)
		);

		// Filter out successful responses for DB storage
		const successfulResponses = aiResponses.filter(
			(response): response is AIAnswer => !("error" in response)
		);

		// Only update the database if there are successful responses
		if (successfulResponses.length > 0) {
			try {
				await gameContainer.item(gameId, gameId).patch([
					{
						op: "add",
						path: "/aiResponses",
						value: successfulResponses,
					},
				]);
				context.log(
					`Successfully stored ${successfulResponses.length} AI responses in the database`
				);
			} catch (dbError) {
				context.error(
					`Error updating game with AI responses: ${
						dbError instanceof Error
							? dbError.message
							: "Unknown error"
					}`
				);
				// Continue execution despite DB error to return what we have to the client
			}
		}

		// Prepare error summary for logging purposes
		const errorResponses = aiResponses.filter(
			(response) => "error" in response
		) as AIAnswerError[];
		if (errorResponses.length > 0) {
			context.log(
				`${errorResponses.length} errors occurred during processing`
			);
			errorResponses.forEach((err) => {
				context.log(
					`Player ${err.playerId}, Question ${err.questionId}: ${
						err.error
					} - ${err.details || "No details"}`
				);
			});
		}

		return {
			status: 200,
			jsonBody: {
				message: "Processed player assistants with questions",
				gameId: gameId,
				processedCount: successfulResponses.length,
				errorCount: errorResponses.length,
				totalPlayers: players.length,
				totalQuestions: judgeQuestions.length,
				expectedTotal: players.length * judgeQuestions.length,
				responses: aiResponses,
			},
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		context.error(`Global error in generateAnswers: ${errorMessage}`);
		return {
			status: 500,
			jsonBody: {
				error: "Internal server error occurred",
				message: errorMessage,
			},
		};
	}
}

// Helper function to sanitize inputs before sending to OpenAI
function sanitizeInput(input: string): string {
	if (!input) return "";

	// Remove any potentially problematic characters or patterns
	return input
		.replace(/^\s+|\s+$/g, "") // Trim whitespace
		.replace(/[^\w\s.,?!;:()'"]/g, " ") // Replace special chars with space
		.replace(/\s+/g, " "); // Normalize whitespace
}

// Create a structured prompt to reduce content filter triggers
function createPrompt(assistantPrompt: string, question: string): string {
	return `You are an AI assistant with the following characteristics:
${assistantPrompt}

Please respond to this question in a helpful, accurate, and appropriate manner:
"${question}"

Keep your answer concise (no more than 1-2 sentences).`;
}

app.http("generateAnswers", {
	methods: ["GET", "POST"],
	authLevel: "anonymous",
	handler: generateAnswers,
});
