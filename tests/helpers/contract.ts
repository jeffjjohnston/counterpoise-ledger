import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import document from "../../openapi/openapi.json";

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
