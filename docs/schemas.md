# TypeBox schemas

The [Norn SDK](../packages/sdk/src/api.ts) accepts native `typebox` 1.x schemas for workflow params, config, state and agent responses. This reference is checked against 1.3.33. [Project loading](projects.md#import-and-reload) describes runtime-provided imports and editor dependency resolution.

## TypeScript → TypeBox

```ts
import { Type, type Static } from "typebox";

const Person = Type.Object({ name: Type.String() });
type Person = Static<typeof Person>;
```

Schemas are runtime values; `Static` derives the TypeScript type. In the table, `S`, `A` and `B` are schemas, with corresponding inferred types `T`, `TA` and `TB`.

| TypeScript type | TypeBox schema |
|---|---|
| `string` | `Type.String()` |
| `number` | `Type.Number()` |
| `boolean` | `Type.Boolean()` |
| `null` | `Type.Null()` |
| `undefined` | `Type.Undefined()` |
| `unknown` | `Type.Unknown()` |
| `any` | `Type.Any()` |
| `never` | `Type.Never()` |
| `"ready"` | `Type.Literal("ready")` |
| `string[]` | `Type.Array(Type.String())` |
| `[string, number]` | `Type.Tuple([Type.String(), Type.Number()])` |
| `{ name: string }` | `Type.Object({ name: Type.String() })` |
| `{ name?: string }` | `Type.Object({ name: Type.Optional(Type.String()) })` |
| `{ readonly name: string }` | `Type.Object({ name: Type.Readonly(Type.String()) })` |
| `string \| null` | `Type.Union([Type.String(), Type.Null()])` |
| `TA \| TB` | `Type.Union([A, B])` |
| `TA & TB` | `Type.Intersect([A, B])` |
| `Record<string, number>` | `Type.Record(Type.String(), Type.Number())` |
| `Partial<T>` | `Type.Partial(S)` |
| `Required<T>` | `Type.Required(S)` |
| `Pick<T, "name">` | `Type.Pick(S, ["name"])` |
| `Omit<T, "name">` | `Type.Omit(S, ["name"])` |

`Type.Integer()` also infers `number`; integrality is a runtime constraint. Optional properties may be absent; accepting `null` is a separate union. `Type.Readonly` affects static typing, not runtime freezing. `Type.Unknown` and `Type.Any` accept any value at runtime but infer different TypeScript types; neither guarantees JSON serializability. JavaScript-only values such as `undefined`, `bigint`, functions and symbols are not JSON data contracts.

## Constraints and validation

```ts
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Compile } from "typebox/compile";

const Task = Type.Object({
  title: Type.String({ minLength: 1 }),
  attempts: Type.Integer({ minimum: 1, maximum: 10 }),
}, { additionalProperties: false });

const valid = Value.Check(Task, { title: "Build", attempts: 3 });
const invalid = Value.Check(Task, { title: "Build", attempts: "3" });
const issues = Value.Errors(Task, { title: "", attempts: 0 });
const validator = Compile(Task);
const compiledValid = validator.Check({ title: "Build", attempts: 3 });
```

`valid` and `compiledValid` are `true`; `invalid` is `false`. `Value.Check` tests without repairing the input. `Value.Assert` throws on failure. `Value.Parse` returns validated input with the default `correctiveParse: false` setting; enabling that setting adds repair operations. `Value.Errors` returns issues with fields including `keyword`, `instancePath`, `schemaPath` and `message`. `Compile` creates a reusable validator.

Objects permit additional properties by default. `additionalProperties: false` rejects extras during validation; it does not strip them. A `default` annotation neither makes a property optional nor fills it during `Value.Check`. `Value.Default` is a separate operation; `Value.Convert` and `Value.Clean` likewise explicitly convert and clean values rather than merely validate them.

## Tagged unions and refinements

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Outcome = Type.Union([
  Type.Object({ kind: Type.Literal("done"), summary: Type.String() }),
  Type.Object({ kind: Type.Literal("retry"), reason: Type.String() }),
]);
type Outcome = Static<typeof Outcome>;

const UniqueNames = Type.Refine(
  Type.Array(Type.String()),
  names => new Set(names).size === names.length,
  () => "Names must be unique",
);
const distinct = Value.Check(UniqueNames, ["build", "review"]);
const repeated = Value.Check(UniqueNames, ["build", "build"]);
```

The literal `kind` supports TypeScript narrowing and distinguishes runtime branches. `Type.Refine` adds a predicate to an existing schema: `distinct` is `true`, `repeated` is `false`. The predicate executes in TypeBox; serializing the schema as JSON does not carry that function into another validator.

## Recursive data

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Tree = Type.Cyclic({
  Node: Type.Object({
    name: Type.String(),
    children: Type.Array(Type.Ref("Node")),
  }),
}, "Node");
type Tree = Static<typeof Tree>;

const tree: Tree = { name: "root", children: [{ name: "leaf", children: [] }] };
const validTree = Value.Check(Tree, tree);
```

`Type.Cyclic` supplies definitions and selects the root; `Type.Ref` resolves a definition within that context. This describes recursive data shapes, not circular JavaScript object identities.

## Codecs and input/output types

```ts
import { Type, type StaticEncode, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

const CountText = Type.Codec(Type.String({ pattern: "^[0-9]+$" }))
  .Decode(text => Number(text))
  .Encode(count => String(count));

type CountInput = StaticEncode<typeof CountText>;
type CountOutput = StaticDecode<typeof CountText>;

const count = Value.Decode(CountText, "42");
const text = Value.Encode(CountText, 42);
```

`CountInput` is `string`, `CountOutput` is `number`; the values are `42` and `"42"`. `Static` uses the encoded/input direction. `Type.Decode(schema, callback)` defines a decode-only codec instead of a bidirectional one.

`Value.Decode` is not a validation-only operation: in this version it clones, applies defaults, converts, cleans, validates, then runs decode callbacks. `Value.Check` and `Value.Assert` do not run codec callbacks. Callback behavior remains executable TypeBox code, not portable JSON Schema validation.

## Norn boundaries

| Boundary | Native operation and value type |
|---|---|
| Workflow params, plugin config, agent responses | `Value.Decode`: defaults, conversion, cleaning, validation and codec callbacks. Callers supply `StaticEncode`; implementations receive `StaticDecode`. |
| Project/include files | `Value.Default` followed by `Value.Parse`: fill configuration defaults and validate without type coercion. |
| State and persisted resource/lock records | `Value.Parse`: validate stored values without decoding. State values use `Static` (encoded types) and must be JSON data. |
| Inspection and agent schema instructions | Serialized input schema, checked against the JSON Schema meta-schema. Runtime refinements and codecs remain executable functions, not portable JSON rules. |

Default annotations do not make statically required inputs optional. `Type.Optional` controls that separately. TypeBox infers decoded callback return types; a codec can explicitly produce a required field from an optional input.

State leaves are TypeBox schemas directly, with nested objects providing grouping:

```ts
import { definePluginManifest } from "@vimhead.dev/norn";
import { Type } from "typebox";

const manifest = definePluginManifest({
  id: "progress",
  workflows: {},
  states: {
    count: Type.Integer(),
    details: { name: Type.String() },
  },
});
```

These declarations produce `manifest.states.count.id === "progress.count"` and `manifest.states.details.name.id === "progress.details.name"`. A leaf can instead use `{ id, description, schema }` for explicit metadata. [Persistence](persistence.md) owns state lifetime and storage.

Gates, queued runs and recovery retain encoded params. Config overrides merge with encoded config before decoding; they do not re-decode previously transformed results. Codecs may run at validation, gate-description and execution boundaries, each against encoded input.

Further API reference: [TypeBox documentation](https://sinclairzx81.github.io/typebox/).
