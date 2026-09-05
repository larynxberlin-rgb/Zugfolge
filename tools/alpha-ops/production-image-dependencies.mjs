import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Resolve through the shipped API graph, not the host lockfile or an unused
// package-store entry. This same file is copied into the canonical image.
const apiRequire = createRequire(new URL("../../apps/game-api/package.json", import.meta.url));
const fastifyRequire = createRequire(apiRequire.resolve("fastify/package.json"));
const compilerRequire = createRequire(fastifyRequire.resolve("@fastify/ajv-compiler/package.json"));
const ajvRequire = createRequire(compilerRequire.resolve("ajv/package.json"));
const stringifyRequire = createRequire(fastifyRequire.resolve("fast-json-stringify/package.json"));
const installed = {
  schemaValidation: ajvRequire("fast-uri/package.json").version,
  responseSerialization: stringifyRequire("fast-uri/package.json").version,
};
assert.deepEqual(installed, { schemaValidation: "3.1.7", responseSerialization: "4.1.4" });
for (const require of [ajvRequire, stringifyRequire]) {
  assert.equal(require("fast-uri").parse("https://example.invalid/path?query=1").host, "example.invalid");
}

const app = apiRequire("fastify")({ logger: false });
app.get("/dependency-smoke", {
  schema: {
    querystring: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } },
    response: { 200: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } },
  },
}, async (request) => ({ url: request.query.url }));
try {
  const valid = await app.inject({ method: "GET", url: "/dependency-smoke?url=https%3A%2F%2Fexample.invalid%2Fpath" });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { url: "https://example.invalid/path" });
  const invalid = await app.inject({ method: "GET", url: "/dependency-smoke?url=not-a-uri" });
  assert.equal(invalid.statusCode, 400);
  console.log(JSON.stringify({ fastUri: installed, apiSchemaAndSerialization: "passed" }));
} finally {
  await app.close();
}
