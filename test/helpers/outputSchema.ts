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

/**
 * Every key an emitted payload carries that the advertised schema does not declare, as pointers
 * in {@link declaredField}'s own syntax (so a reported one can be pasted straight into
 * {@link expectDeclaredField}).
 *
 * This is the direction the two `expect*Field` helpers structurally cannot reach. They take a
 * pointer, so they can only ever answer a question somebody already thought to ask; the hole
 * #130 is about is a key **nobody thought to ask about** — emitted by the handler, absent from
 * the schema, passed through by the SDK unstripped and unvalidated. Finding one by name requires
 * guessing its name. Walking the payload does not.
 *
 * Judged on the **wire form** — `JSON.parse(JSON.stringify(...))` — not on the object the handler
 * built, and that distinction is load-bearing rather than pedantic. An explicitly-`undefined` key
 * (`{ snippet: undefined }`, which `withoutUnopenableLocation` produces) is a real own property of
 * the handler's object and survives `InMemoryTransport`, which hands the object across by
 * reference; it does **not** survive JSON serialization, so over a stdio server it reaches no
 * client and is no contract hole at all. Reporting it as one is how an audit run over the
 * in-memory transport manufactures findings that cannot exist in production (#137 records
 * `compile`'s `warnings[].snippet` as precisely this non-hole).
 *
 * A key counts as declared when **any** branch of a union declares it, and an array's elements are
 * judged against every branch's `items`. Where the schema publishes nothing about a value's
 * interior (an array with no `items`, a node with no object branch at all), its children are not
 * walked: this helper reports keys the schema contradicts, never keys it simply says nothing
 * about — the latter is not something a client could be misled by.
 */
export function undeclaredKeys(schema: JsonSchemaNode, structuredContent: unknown): string[] {
  const wire: unknown =
    structuredContent === undefined ? undefined : JSON.parse(JSON.stringify(structuredContent));
  const out = new Set<string>();
  collectUndeclared([schema], wire, '', out);
  return [...out].sort();
}

function collectUndeclared(
  nodes: JsonSchemaNode[],
  value: unknown,
  prefix: string,
  out: Set<string>,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    const items = nodes
      .flatMap((n) => itemBranches(n))
      .map((b) => b.items)
      .filter((n): n is JsonSchemaNode => n !== undefined);
    if (items.length === 0) return;
    for (const element of value) collectUndeclared(items, element, `${prefix}[]`, out);
    return;
  }
  const holders = nodes.flatMap((n) => objectBranches(n));
  if (holders.length === 0) return;
  for (const [key, child] of Object.entries(value)) {
    const pointer = prefix ? `${prefix}.${key}` : key;
    const declared = holders
      .map((h) => h.properties![key])
      .filter((n): n is JsonSchemaNode => n !== undefined);
    if (declared.length === 0) out.add(pointer);
    else collectUndeclared(declared, child, pointer, out);
  }
}

/**
 * Assert that a tool's result carries **no** key its advertised `outputSchema` fails to declare.
 *
 * The assertion is on the whole set, not a subset: `knownUndeclared` names the holes a filed
 * issue already covers, and a hole that gets fixed makes this fail too ("expected
 * [`shelf.version`], got []"), so the fix has to come here and delete the entry. An allow-list
 * that merely tolerated its entries would go stale silently, which is the same defect in the test
 * layer that #130 found in the SDK.
 *
 * A result with no `structuredContent` at all is a failure rather than a pass: there is nothing to
 * compare, and a call that quietly started erroring would otherwise turn this into a test that
 * cannot fail.
 */
export async function expectNoUndeclaredKeys(
  client: Client,
  toolName: string,
  structuredContent: unknown,
  opts: { knownUndeclared?: string[] } = {},
): Promise<void> {
  expect(
    structuredContent,
    `\`${toolName}\` returned no structuredContent, so there is nothing to check against the ` +
      `advertised outputSchema — the call probably failed. Assert the call succeeded first.`,
  ).toBeDefined();
  const schema = await advertisedOutputSchema(client, toolName);
  const found = undeclaredKeys(schema, structuredContent);
  const known = [...(opts.knownUndeclared ?? [])].sort();
  expect(
    found,
    `\`${toolName}\` emitted key(s) its advertised outputSchema does not declare. The MCP SDK ` +
      `validates a result against that schema, throws the parse result away and forwards the ` +
      `handler's own object, so an undeclared key reaches every client unvalidated and ` +
      `unstripped while no client is told it exists (#130). Either declare it, or stop emitting ` +
      `it. If a filed issue already covers it, name it in knownUndeclared — and delete it there ` +
      `when the fix lands, which is what this equality (rather than a subset check) forces.`,
  ).toEqual(known);
}
