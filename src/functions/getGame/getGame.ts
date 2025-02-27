import { CosmosClient } from "@azure/cosmos";
import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";

export async function getGame(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	context.log(`Http function processed request for url "${request.url}"`);

	const gameId = request.query.get("gameId");

	if (!gameId) {
		return {
			status: 400,
			body: "Please pass a gameId on the query string",
		};
	}

	const client = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
	const database = client.database("mini-prompt-quiz");
	const gameContainer = database.container("games");

	const game = await gameContainer.item(gameId, gameId).read();

	if (!game.resource) {
		return { status: 404, body: "Game not found" };
	}

	const gameObj = {
		id: game.resource.id,
		players: game.resource.players,
		theme: game.resource.judge.theme,
	};

	return { status: 200, body: JSON.stringify(gameObj) };
}

app.http("getGame", {
	methods: ["GET", "POST"],
	authLevel: "anonymous",
	handler: getGame,
});
