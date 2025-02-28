import { CosmosClient } from "@azure/cosmos";
import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";

interface Player {
	id: string;
	screenName: string;
	totalScore: number;
	themeName: string;
	gameId: string;
	// Add any other player fields you need
}

export async function getLeaderBoard(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	context.log(`Http function processed request for url "${request.url}"`);

	try {
		// Get gameId from query parameter if you want to filter by game
		const gameId = request.query.get("gameId");

		// Initialize Cosmos DB client
		const client = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
		const database = client.database("mini-prompt-quiz");
		const playerContainer = database.container("players");

		// Build the query
		let querySpec: any = {
			query: "SELECT p.id, p.screenName, p.totalScore, p.themeName, p.gameId FROM players p WHERE IS_DEFINED(p.totalScore) ORDER BY p.totalScore DESC OFFSET 0 LIMIT 5",
			parameters: [],
		};

		// Add gameId filter if provided
		if (gameId) {
			querySpec = {
				query: "SELECT p.id, p.screenName, p.totalScore, p.themeName, p.gameId FROM players p WHERE p.gameId = @gameId AND IS_DEFINED(p.totalScore) ORDER BY p.totalScore DESC OFFSET 0 LIMIT 5",
				parameters: [
					{
						name: "@gameId",
						value: gameId,
					},
				],
			};
		}

		// Execute the query
		const { resources: players } = await playerContainer.items
			.query<Player>(querySpec)
			.fetchAll();

		// Transform data for presentation if needed
		const leaderboard = players.map((player, index) => ({
			rank: index + 1,
			id: player.id,
			name: player.screenName,
			score: player.totalScore,
			theme: player.themeName,
			gameId: player.gameId,
		}));

		return {
			status: 200,
			jsonBody: {
				leaderboard,
				timestamp: new Date().toISOString(),
			},
		};
	} catch (error) {
		context.error("Error retrieving leaderboard:", error);
		return {
			status: 500,
			jsonBody: {
				error: "Error retrieving leaderboard",
				message:
					error instanceof Error ? error.message : "Unknown error",
			},
		};
	}
}

app.http("getLeaderBoard", {
	methods: ["GET", "POST"],
	authLevel: "anonymous",
	handler: getLeaderBoard,
});
