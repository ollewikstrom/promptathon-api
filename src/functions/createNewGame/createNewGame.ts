import { CosmosClient } from "@azure/cosmos";
import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";

import { v4 as uuid } from "uuid";

const themes = ["Coffee", "Microsoft", "Space"];

export async function createNewGame(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	context.log(`Processing request for URL "${request.url}"`);

	//Pick a random theme
	const theme = themes[Math.floor(Math.random() * themes.length)];

	const client = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
	const database = client.database("mini-prompt-quiz");
	const gameContainer = database.container("games");
	const judgeContainer = database.container("judges");

	const judgeRes = await judgeContainer.items
		.query({
			query: "SELECT * FROM c WHERE c.theme = @theme",
			parameters: [{ name: "@theme", value: theme }],
		})
		.fetchAll();

	console.log("judge", judgeRes);
	const gameId = uuid();

	const judgeResources = judgeRes.resources;
	if (judgeResources.length === 0) {
		return { status: 404, body: "Judge not found" };
	}

	const judge = judgeResources[0];

	const judgeQuestions = judge.questions;

	//Select 3 random questions from the judge
	const selectedQuestions = [];
	for (let i = 0; i < 3; i++) {
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
