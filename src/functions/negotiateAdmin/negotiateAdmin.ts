import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
const { WebPubSubServiceClient } = require('@azure/web-pubsub');

export async function negotiateAdmin(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const hubName = 'miniHackathon';
    const serviceClient = new WebPubSubServiceClient(process.env.WEB_PUBSUB_CONNECTION_STRING, hubName);
    let token = await serviceClient.getClientAccessToken({roles: ["webpubsub.joinLeaveGroup", "webpubsub.sendToGroup"] });
    return { body: JSON.stringify(token), headers: { 'Content-Type': 'application/json' }};
};

app.http('negotiateAdmin', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: negotiateAdmin
});
