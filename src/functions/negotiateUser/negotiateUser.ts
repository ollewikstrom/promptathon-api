import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
const { WebPubSubServiceClient } = require('@azure/web-pubsub');

export async function negotiateUser(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const hubName = 'miniHackathon';
    const serviceClient = new WebPubSubServiceClient(process.env.WEB_PUBSUB_CONNECTION_STRING, hubName);
    const groupId = request.query.get('groupId') || await request.text();
    const userId = request.query.get('userId') || await request.text();
    let token = await serviceClient.getClientAccessToken({roles: [`webpubsub.joinLeaveGroup.${groupId}`, `webpubsub.sendToGroup.${groupId}`], userId, groups: [groupId] });
    return { body: JSON.stringify(token), headers: { 'Content-Type': 'application/json' }};
};

app.http('negotiateUser', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: negotiateUser
});
