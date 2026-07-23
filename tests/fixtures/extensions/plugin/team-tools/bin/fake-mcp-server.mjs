import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "runledger-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
    { name: "slow", description: "Timeout fixture", inputSchema: { type: "object", properties: {} } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "slow") await new Promise((resolve) => setTimeout(resolve, 500));
  return { content: [{ type: "text", text: String(request.params.arguments?.text ?? "slow") }, { type: "resource", resource: { uri: "fixture://resource", text: "fixture resource" } }], structuredContent: { fixture: true } };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "fixture://resource", name: "fixture" }] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "fixture-template" }] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [{ uri: request.params.uri, text: "fixture resource" }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "fixture-prompt", description: "Fixture prompt" }] }));
server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: "user", content: { type: "text", text: "fixture prompt" } }] }));

await server.connect(new StdioServerTransport());
