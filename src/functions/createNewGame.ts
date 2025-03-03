import { CosmosClient } from "@azure/cosmos";
import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";

import { v4 as uuid } from "uuid";

export async function createNewGame(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	context.log(`Processing request for URL "${request.url}"`);

	const client = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
	const database = client.database("mini-prompt-quiz");
	const gameContainer = database.container("games");
	const judgeContainer = database.container("judges");

	// Get all judges from the database
	const allJudgesRes = await judgeContainer.items
		.query({
			query: "SELECT * FROM c",
		})
		.fetchAll();

	// Check if any judges exist
	if (allJudgesRes.resources.length === 0) {
		return { status: 404, body: "No judges found in the database" };
	}

	// Select a random judge
	const randomIndex = Math.floor(
		Math.random() * allJudgesRes.resources.length
	);
	const judge = allJudgesRes.resources[randomIndex];

	const gameId = uuid();
	const judgeQuestions = [...judge.questions]; // Create a copy to avoid modifying the original

	// Select 3 random questions from the judge
	const selectedQuestions = [];
	for (let i = 0; i < 3 && judgeQuestions.length > 0; i++) {
		const questionIndex = Math.floor(Math.random() * judgeQuestions.length);
		// Pop the question from the array so it doesn't get selected again
		const selectedQuestion = judgeQuestions.splice(questionIndex, 1)[0];
		selectedQuestions.push(selectedQuestion);
	}

	const game = {
		id: gameId,
		status: "waiting",
		players: [],
		judge: {
			...judge,
			questions: selectedQuestions,
		},
	};

	const createdGame = await gameContainer.items.upsert(game);

	if (!createdGame) {
		return { status: 500, body: "Failed to create game" };
	}

	return { status: 200, body: JSON.stringify(game) };
}

app.http("createNewGame", {
	methods: ["GET", "POST"],
	authLevel: "anonymous",
	handler: createNewGame,
});
