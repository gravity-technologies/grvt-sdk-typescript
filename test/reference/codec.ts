// Reference model codec (test only): the generic schema walker the SDK used before the per-type
// functions in src/generated/codec.ts. test/codec.test.ts checks the two agree on contract-derived
// values, including every error.

import { toWire } from "../../src/runtime/codec.js";
import { Decimal, Timestamp } from "../../src/runtime/scalars.js";
import { type ModelSchema, SCHEMA } from "../../src/generated/codec-schema.js";

/** Decode only fields described by the contract; keep unknown fields for forward compatibility. */
export function referenceDecode(
  input: unknown,
  name: string,
  schema: ModelSchema = SCHEMA,
): unknown {
  function decode(value: unknown, kind: string, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (depth > 0) {
      if (!Array.isArray(value)) throw new TypeError(`${kind}: expected an array`);
      return value.map((item: unknown) => decode(item, kind, depth - 1));
    }
    if (kind === "decimal") {
      if (typeof value !== "string") throw new TypeError("decimal must be a string");
      return new Decimal(value);
    }
    if (kind === "timestamp") {
      if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
        throw new TypeError("timestamp must be a string of Unix nanoseconds");
      }
      return new Timestamp(BigInt(value));
    }
    const fields = schema[kind];
    if (!fields) return value;
    if (typeof value !== "object" || Array.isArray(value))
      throw new TypeError(`${kind}: expected an object`);
    const result = { ...(value as Record<string, unknown>) };
    for (const [key, [type, arrayDepth, publicName, optional, nullable]] of Object.entries(
      fields,
    )) {
      if (!optional && !Object.hasOwn(result, key))
        throw new TypeError(`${kind}.${key} is required`);
      if (!nullable && result[key] === null) throw new TypeError(`${kind}.${key} cannot be null`);
      if (Object.hasOwn(result, key)) {
        const decoded = decode(result[key], type, arrayDepth);
        if (publicName !== key) delete result[key];
        result[publicName] = decoded;
      }
    }
    return result;
  }
  return decode(input, name, 0);
}

/** Encode contract-owned field aliases after exact scalar serialization. */
export function referenceEncode(
  input: unknown,
  name: string,
  schema: ModelSchema = SCHEMA,
): unknown {
  function encode(value: unknown, kind: string, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (depth > 0) {
      if (!Array.isArray(value)) throw new TypeError(`${kind}: expected an array`);
      return value.map((item: unknown) => encode(item, kind, depth - 1));
    }
    const fields = schema[kind];
    if (!fields) return value;
    if (typeof value !== "object" || Array.isArray(value))
      throw new TypeError(`${kind}: expected an object`);
    const result = { ...(value as Record<string, unknown>) };
    for (const [wireName, [type, arrayDepth, publicName, optional, nullable]] of Object.entries(
      fields,
    )) {
      if (!optional && !Object.hasOwn(result, publicName))
        throw new TypeError(`${kind}.${publicName} is required`);
      if (!nullable && result[publicName] === null)
        throw new TypeError(`${kind}.${publicName} cannot be null`);
      if (Object.hasOwn(result, publicName)) {
        const encoded = encode(result[publicName], type, arrayDepth);
        if (publicName !== wireName) delete result[publicName];
        result[wireName] = encoded;
      }
    }
    return result;
  }
  return encode(toWire(input), name, 0);
}
