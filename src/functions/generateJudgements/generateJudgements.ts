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
	deployment: "gpt-4o",
	apiVersion: "2024-05-01-preview",
});

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

interface Judgement {
	id: string;
	gameId: string;
	aiAnswerId: string;
	playerId: string;
	questionId: string;
	contextScore: number;
	technicalScore: number;
	clarityScore: number;
	totalScore: number;
	justification: string;
	timestamp: string;
}

export async function generateJudgements(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	try {
		context.log(`Processing judgement request for URL "${request.url}"`);

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

		// Fetch the game and its AI responses
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

		const aiResponses: AIAnswer[] = game.aiResponses || [];
		const judge = game.judge;
		if (aiResponses.length === 0) {
			return {
				status: 404,
				jsonBody: {
					error: "No AI responses found for judgement",
				},
			};
		}

		// Process each AI response with the judge assistant
		const judgements = await Promise.all(
			aiResponses.map(async (response) => {
				let thread;
				try {
					// Create a thread for this evaluation
					thread = await openAIClient.beta.threads.create();

					// Add the message to the thread
					await openAIClient.beta.threads.messages.create(thread.id, {
						role: "user",
						content: `Q: "${response.question}"\n\nA: "${response.answer}"`,
					});

					// Create a run
					const run = await openAIClient.beta.threads.runs.create(
						thread.id,
						{
							assistant_id: judge.asst_id,
						}
					);

					// Poll for completion with better error handling
					const completedRun = await waitForRunCompletion(
						openAIClient,
						thread.id,
						run.id,
						context
					);

					// Get the assistant's response
					const messages =
						await openAIClient.beta.threads.messages.list(
							thread.id
						);

					if (!messages.data || messages.data.length === 0) {
						throw new Error("No messages found in thread");
					}

					const lastMessage = messages.data[0];
					const textContent = lastMessage.content.find(
						(content) => "text" in content
					);

					if (!textContent || !("text" in textContent)) {
						throw new Error(
							"No text content found in assistant response"
						);
					}

					// Parse the formatted response
					const judgementContent = await parseFormattedResponse(
						textContent.text.value,
						context
					);

					return {
						id: `${gameId}-judge-${response.id}`,
						gameId: gameId,
						aiAnswerId: response.id,
						playerId: response.playerId,
						playerName: response.playerName,
						questionId: response.questionId,
						contextScore: judgementContent.contextScore,
						technicalScore: judgementContent.technicalScore,
						clarityScore: judgementContent.clarityScore,
						totalScore: judgementContent.totalScore,
						justification: judgementContent.justification,
						timestamp: new Date().toISOString(),
					};
				} catch (error) {
					await context.error(
						`Error processing response ${response.id}:`,
						error
					);
					throw error;
				} finally {
					// Clean up the thread even if there was an error
					if (thread?.id) {
						try {
							await openAIClient.beta.threads.del(thread.id);
						} catch (cleanupError) {
							await context.error(
								"Error cleaning up thread:",
								cleanupError
							);
						}
					}
				}
			})
		);

		// Update the game with judgements
		await gameContainer.item(gameId, gameId).patch([
			{
				op: "add",
				path: "/judgements",
				value: judgements,
			},
		]);

		// Calculate summary statistics
		const playerScores = {};
		judgements.forEach((judgement) => {
			if (!playerScores[judgement.playerId]) {
				playerScores[judgement.playerId] = {
					totalScores: [],
					contextScores: [],
					technicalScores: [],
					clarityScores: [],
				};
			}
			playerScores[judgement.playerId].totalScores.push(
				judgement.totalScore
			);
			playerScores[judgement.playerId].contextScores.push(
				judgement.contextScore
			);
			playerScores[judgement.playerId].technicalScores.push(
				judgement.technicalScore
			);
			playerScores[judgement.playerId].clarityScores.push(
				judgement.clarityScore
			);
		});

		return {
			status: 200,
			jsonBody: {
				message:
					"Successfully generated judgements for all AI responses",
				gameId: gameId,
				processedCount: judgements.length,
				judgements: judgements,
			},
		};
	} catch (error) {
		context.error("Error in generateJudgements:", error);
		return {
			status: 500,
			jsonBody: {
				error: "Internal server error occurred",
				message:
					error instanceof Error ? error.message : "Unknown error",
			},
		};
	}
}

async function parseFormattedResponse(
	response: string,
	context: InvocationContext
) {
	// Remove backticks and any leading/trailing whitespace
	response = response.replace(/```/g, "").trim();

	// Extract scores with or without denominators
	const contextMatch = response.match(/Context Score:\s*(\d+)(?:\/300)?/);
	const technicalMatch = response.match(/Technical Score:\s*(\d+)(?:\/400)?/);
	const clarityMatch = response.match(/Clarity Score:\s*(\d+)(?:\/300)?/);
	const finalMatch = response.match(/Final Score:\s*(\d+)(?:\/1000)?/);

	// Updated justification regex to handle multiline text
	const justificationMatch = response.match(
		/Justification:\s*([\s\S]+?)(?=\n|$)/
	);

	if (!contextMatch) throw new Error("Could not parse Context Score");
	if (!technicalMatch) throw new Error("Could not parse Technical Score");
	if (!clarityMatch) throw new Error("Could not parse Clarity Score");
	if (!finalMatch) throw new Error("Could not parse Final Score");
	if (!justificationMatch) throw new Error("Could not parse Justification");

	return {
		contextScore: parseInt(contextMatch[1]),
		technicalScore: parseInt(technicalMatch[1]),
		clarityScore: parseInt(clarityMatch[1]),
		totalScore: parseInt(finalMatch[1]),
		justification: justificationMatch[1].trim(),
	};
}

async function waitForRunCompletion(
	openai: AzureOpenAI,
	threadId: string,
	runId: string,
	context: InvocationContext
) {
	let attempts = 0;
	const maxAttempts = 30; // 30 seconds timeout

	while (attempts < maxAttempts) {
		try {
			const run = await openai.beta.threads.runs.retrieve(
				threadId,
				runId
			);

			switch (run.status) {
				case "completed":
					return run;
				case "failed":
					const errorDetails = run.last_error
						? `: ${run.last_error.message}`
						: "";
					throw new Error(`Run failed${errorDetails}`);
				case "cancelled":
				case "expired":
					throw new Error(`Run ${run.status}`);
				case "requires_action":
					throw new Error("Run requires action - not supported");
				default:
					// For queued, in_progress, etc.
					await new Promise((resolve) => setTimeout(resolve, 1000));
					attempts++;
			}
		} catch (error) {
			if (error.message?.includes("Rate limit")) {
				await context.log(`Rate limit hit, waiting before retry...`);
				// Extract wait time from error message or default to 60 seconds
				const waitTime = error.message.match(
					/Try again in (\d+) seconds/
				)
					? parseInt(
							error.message.match(/Try again in (\d+) seconds/)[1]
					  )
					: 60;
				await new Promise((resolve) =>
					setTimeout(resolve, waitTime * 1000)
				);
				continue; // Retry after waiting
			}
			throw error;
		}
	}

	throw new Error(`Run timed out after ${maxAttempts} seconds`);
}

app.http("generateJudgements", {
	methods: ["GET", "POST"],
	authLevel: "anonymous",
	handler: generateJudgements,
});
