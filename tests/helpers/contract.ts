import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import document from "../../openapi/openapi.json";
import routes from "../../rust-api/routes.json";

type Node = unknown;

/**
 * A copy of a schema in which every object with properties refuses any other
 * key. The document leaves `additionalProperties` out so that a client
 * accepts a field it does not know yet (guides/api-contract.md, rule 6). The
 * server must not send one, so a test checks the stricter shape.
 */
function strict(node: Node): Node {
  if (Array.isArray(node)) return node.map(strict);
  if (!node || typeof node !== "object") return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = key === "properties" && value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, strict(schema)]))
      : strict(value);
  }
  if ("properties" in copy) copy.additionalProperties = false;
  return copy;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: { schemas: strict(document.components.schemas) } });

export type Contract<T> = {
  /** The value, typed, or an error that lists each difference from the schema. */
  parse: (value: unknown) => T;
  safeParse: (value: unknown) => { success: boolean; errors: ValidateFunction["errors"] };
};

/**
 * A component schema of openapi/openapi.json, as a strict validator of a
 * response body. The Rust server writes the document, so this checks each
 * response against the contract itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function contract<T = any>(name: string): Contract<T> {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (!validate || !(name in document.components.schemas)) {
    throw new Error(`${name} is not a component schema of openapi/openapi.json`);
  }
  return {
    parse(value) {
      if (!validate(value)) {
        throw new Error(`The body does not match ${name}: ${ajv.errorsText(validate.errors)}`);
      }
      return value as T;
    },
    safeParse(value) {
      const success = Boolean(validate(value));
      return { success, errors: validate.errors };
    },
  };
}

type Operation = { responses?: Record<string, { content?: Record<string, { schema?: Node }> }> };
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Each route of the server, with a pattern for its path and its operation
 * in the document, if it has one. All routes are here, not only those of
 * the document, because a path can match two routes:
 * `/securities/prices-due` also has the form of `/securities/[id]`. The
 * router gives a request to the route with the literal segment, so the
 * route with the fewest parameters comes first.
 */
const ROUTES = routes
  .map((route) => {
    const template = route.path.replace(/\[(\w+)\]/g, "{$1}");
    const item = (document.paths as Record<string, Record<string, Operation>>)[template];
    return {
      method: route.method,
      template,
      parameters: route.path.split("[").length - 1,
      // `[id]` takes one path segment.
      pattern: new RegExp(`^${route.path.split(/\[\w+\]/).map(escapeRegExp).join("[^/]+")}$`),
      operation: item?.[route.method.toLowerCase() as (typeof METHODS)[number]],
    };
  })
  .sort((a, b) => a.parameters - b.parameters);

/** The route that the router gives this request to. */
function routeFor(method: string, pathname: string) {
  return ROUTES.find((route) => route.method === method.toUpperCase() && route.pattern.test(pathname));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const responseValidators = new Map<string, ValidateFunction | null>();

/**
 * The strict validator of the JSON body that the document gives for
 * `status` of the operation at `method` and `pathname`. Null when the
 * document has no such operation, or no JSON body for the status: only the
 * routes of the contract are in the document (guides/api-contract.md).
 */
function responseValidator(method: string, pathname: string, status: number) {
  const found = routeFor(method, pathname);
  if (!found?.operation) return null;
  const key = `${found.method} ${found.template} ${status}`;
  if (!responseValidators.has(key)) {
    const schema = found.operation.responses?.[String(status)]?.content?.["application/json"]?.schema;
    // A reference in the document is relative to the document.
    const absolute = schema === undefined
      ? undefined
      : JSON.parse(JSON.stringify(strict(schema)).replaceAll('"#/components/', '"openapi#/components/')) as object;
    responseValidators.set(key, absolute === undefined ? null : ajv.compile(absolute));
  }
  const validate = responseValidators.get(key);
  return validate ? { validate, name: `${found.method} ${found.template}` } : null;
}

/** Whether the document has an operation for this request. */
export function inContract(method: string, pathname: string): boolean {
  return routeFor(method, pathname)?.operation !== undefined;
}

/**
 * Throws when a successful response of an operation of the document does
 * not match the schema that the document gives for it. `sessionHttpClient`
 * calls this for each response, so each HTTP test checks the contract of the
 * routes it calls, also when the test itself looks at one field only.
 */
export function assertResponseContract(method: string, pathname: string, status: number, body: unknown): void {
  if (status < 200 || status > 299) return;
  const found = responseValidator(method, pathname, status);
  if (!found || found.validate(body)) return;
  throw new Error(
    `The ${status} body of ${method.toUpperCase()} ${pathname} does not match the contract of ` +
      `${found.name} in openapi/openapi.json: ${ajv.errorsText(found.validate.errors)}`,
  );
}
