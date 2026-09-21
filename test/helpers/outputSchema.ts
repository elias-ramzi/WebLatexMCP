/**
 * Asserting a tool's **advertised** `outputSchema`, off a real `listTools()` round trip.
 *
 * Why this exists (issue #130). `McpServer` validates a tool result against the tool's output
 * schema and then throws the parse result away
 * (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`: only `parseResult.success` is
 * consulted, `parseResult.data` is never used). So:
 *
 * - a **required field missing** from `structuredContent` fails the parse and surfaces as an
 *   `McpError` — that direction is caught, and a test asserting on `structuredContent` sees it;
 * - a field **present in `structuredContent` but absent from the `outputSchema`** passes the
 *   parse (a zod object strips by default, it does not reject), is **not** stripped from what the
 *   client receives (the handler's own object is forwarded), and reaches the caller undeclared.
 *
 * So an assertion on `structuredContent` alone pins the **handler**, never the declared contract.
 * A field can be emitted forever while missing from the schema a model reads to decide whether it
 * exists, and the test stays green — which is exactly what happened to `pdf_geometry`'s
 * `floatsRefused` in #128.
 *
 * These helpers go the other way round: they read the JSON Schema the server actually publishes
 * over `tools/list`, which is the document a client receives, converted by the SDK rather than by
 * us. Use them in a test whose stated purpose IS the output contract; a test of what the handler
 * computes should keep asserting on `structuredContent` and nothing else.
 */
import { expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** The slice of JSON Schema these helpers walk. Deliberately structural: what `tools/list` ships. */
export interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

/** A field the advertised schema declares, and whether its holder lists it in `required`. */
export interface DeclaredField {
  /** The pointer that resolved to it, echoed back for assertion messages. */
  pointer: string;
  /** The JSON Schema node for the field itself. */
  node: JsonSchemaNode;
  /** True when the object declaring it lists it in `required` (i.e. never absent). */
  required: boolean;
}

/** Every object branch a node can hold properties on (a `.optional()`/nullable union included). */
function objectBranches(node: JsonSchemaNode): JsonSchemaNode[] {
  if (node.properties) return [node];
  const union = node.anyOf ?? node.oneOf;
  return union ? union.filter((b) => b.properties) : [];
}

/** Every array branch, for an `x[]` step. */
function itemBranches(node: JsonSchemaNode): JsonSchemaNode[] {
  if (node.items) return [node];
  const union = node.anyOf ?? node.oneOf;
  return union ? union.filter((b) => b.items) : [];
}

/**
 * Fetch the `outputSchema` a tool publishes to clients. Throws — rather than returning undefined —
 * when the tool is unregistered or advertises no schema at all, so those two failures name
 * themselves instead of surfacing as "expected undefined to be defined".
 */
export async function advertisedOutputSchema(
  client: Client,
  toolName: string,
): Promise<JsonSchemaNode> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(
      `tool \`${toolName}\` is not registered; tools/list advertises: ${tools
        .map((t) => t.name)
        .sort()
        .join(', ')}`,
    );
  }
  if (!tool.outputSchema) {
    throw new Error(`tool \`${toolName}\` advertises no outputSchema at all`);
  }
  return tool.outputSchema as JsonSchemaNode;
}

/**
 * Resolve a pointer against an advertised schema. The pointer is dotted, with `[]` for a step into
 * an array's items: `floatsRefused`, `pages[].annotationImagesSkipped`,
 * `pages[].images[].unreliableCtm`.
 *
 * Returns `undefined` when any step is undeclared — which is the answer this whole module exists
 * to get, so it is a value, not a throw.
 */
export function declaredField(schema: JsonSchemaNode, pointer: string): DeclaredField | undefined {
  let node: JsonSchemaNode = schema;
  let required = false;
  for (const step of pointer.split('.')) {
    let name = step;
    let arrays = 0;
    while (name.endsWith('[]')) {
      arrays += 1;
      name = name.slice(0, -2);
    }
    const holder = objectBranches(node).find((b) => b.properties && name in b.properties);
    if (!holder) return undefined;
    required = (holder.required ?? []).includes(name);
    node = holder.properties![name]!;
    for (let i = 0; i < arrays; i += 1) {
      const array = itemBranches(node)[0];
      if (!array) return undefined;
      node = array.items!;
    }
  }
  return { pointer, node, required };
}

/** The property names declared alongside a pointer's last step, for a failure message. */
function siblingsOf(schema: JsonSchemaNode, pointer: string): string[] {
  const steps = pointer.split('.');
  const parent = steps.slice(0, -1).join('.');
  const node = parent ? declaredField(schema, parent)?.node : schema;
  if (!node) return [];
  return objectBranches(node)
    .flatMap((b) => Object.keys(b.properties!))
    .sort();
}

/**
 * Assert that a tool **declares** a field in the schema it publishes, and return that field's
 * node so a caller can go on asserting about it (its `description`, say).
 *
 * `required: true` asks for more than presence: that the declaring object lists it in `required`,
 * so a caller never has to read an absent field as a zero. `description` is matched against the
 * declared text, for a field whose meaning is the thing being pinned.
 */
export async function expectDeclaredField(
  client: Client,
  toolName: string,
  pointer: string,
  opts: { required?: boolean; description?: RegExp | string } = {},
): Promise<JsonSchemaNode> {
  const schema = await advertisedOutputSchema(client, toolName);
  const field = declaredField(schema, pointer);
  expect(
    field,
    `\`${toolName}\` does not declare \`${pointer}\` in the outputSchema it advertises — a key ` +
      `the MCP SDK passes through undeclared, so no client is told it exists. Declared ` +
      `alongside it: ${siblingsOf(schema, pointer).join(', ') || '(nothing)'}`,
  ).toBeDefined();
  if (opts.required !== undefined) {
    expect(
      field!.required,
      `\`${toolName}\`.\`${pointer}\` should be ${opts.required ? 'required' : 'optional'} in the ` +
        `advertised outputSchema`,
    ).toBe(opts.required);
  }
  if (opts.description !== undefined) {
    const text = field!.node.description ?? '';
    if (typeof opts.description === 'string') expect(text).toContain(opts.description);
    else expect(text).toMatch(opts.description);
  }
  return field!.node;
}

/**
 * Assert that a tool declares **no** such field. The inverse is a real claim for a tool whose
 * contract deliberately omits something (`add_asset` returns no `diff`): the SDK never rejects a
 * declared-but-unsent optional field either, so "the handler did not emit it" does not show that
 * the published contract stops promising it.
 */
export async function expectUndeclaredField(
  client: Client,
  toolName: string,
  pointer: string,
): Promise<void> {
  const schema = await advertisedOutputSchema(client, toolName);
  expect(
    declaredField(schema, pointer),
    `\`${toolName}\` advertises \`${pointer}\` in its outputSchema, which promises callers a ` +
      `field this tool must not return`,
  ).toBeUndefined();
}
