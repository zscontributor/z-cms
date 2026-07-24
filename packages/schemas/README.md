# @zcmsorg/schemas

Shared [Zod](https://zod.dev) contracts between the [Z-CMS](https://z-cms.org) API and its front ends — blocks, content types, permissions, mail and API payloads.

This is a dependency of [`@zcmsorg/plugin-sdk`](https://www.npmjs.com/package/@zcmsorg/plugin-sdk) and [`@zcmsorg/theme-sdk`](https://www.npmjs.com/package/@zcmsorg/theme-sdk); installing either pulls it in. Reach for it directly only if you are validating Z-CMS payloads yourself — a custom client, an integration, a test harness.

## Install

```sh
npm i @zcmsorg/schemas
```

## Usage

```ts
import { BlockDocumentSchema, type BlockDocument } from "@zcmsorg/schemas";

const doc: BlockDocument = BlockDocumentSchema.parse(await res.json());
```

Everything exported is a Zod schema, so `.parse`, `.safeParse` and `z.infer` all work as usual. Block trees are validated to a maximum nesting depth of `MAX_BLOCK_DEPTH`.

## License

MIT © Z-SOFT Co., Ltd.
