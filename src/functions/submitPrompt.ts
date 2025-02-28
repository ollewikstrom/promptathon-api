import { CosmosClient } from "@azure/cosmos";
import {
	app,
	HttpRequest,
	HttpResponseInit,
	InvocationContext,
} from "@azure/functions";
import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { Player } from "./playerReg";

type SubmitPromptRequest = {
	gameId: string;
	userId: string;
	prompt: string;
};

export async function submitPrompt(
	request: HttpRequest,
	context: InvocationContext
): Promise<HttpResponseInit> {
	context.log(`Http function processed request for url "${request.url}"`);

	const { gameId, userId, prompt } =
		(await request.json()) as SubmitPromptRequest;

	const client = new CosmosClient(process.env.COSMOSDB_CONNECTION_STRING);
	const database = client.database("mini-prompt-quiz");
	const playerContainer = database.container("players");

	const player = await playerContainer.item(userId, gameId).read();
	if (!player) {
		return { status: 400, body: "Player not found" };
	}

	const updatedPlayer = { ...player.resource, prompt };

	context.log("Updating player with prompt:", updatedPlayer);

	await playerContainer.items.upsert(updatedPlayer);
	await sendWebPubSubMessage(updatedPlayer, context);

	return { status: 200, body: "Prompt submitted" };
}

async function sendWebPubSubMessage(
	player: Player,
	context: InvocationContext
) {
	try {
		if (!process.env.WEB_PUBSUB_CONNECTION_STRING) {
			throw new Error("WEB_PUBSUB_CONNECTION_STRING is not set");
		}

		const serviceClient = new WebPubSubServiceClient(
			process.env.WEB_PUBSUB_CONNECTION_STRING,
			"miniHackathon"
		);
		const groupClient = serviceClient.group(player.gameId);
		await groupClient.sendToAll({
			message: "A player has submitted a prompt",
			player,
		});

		context.log("Web PubSub message sent successfully");
	} catch (error) {
		context.error("Failed to send Web PubSub message:", error);
	}
}

app.http("submitPrompt", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: submitPrompt,
});
