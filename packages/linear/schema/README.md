# Linear GraphQL schema (vendored)

`linear.graphql` is Linear's public GraphQL SDL, pinned to the
`@linear/sdk@98.0.0` release tag:

https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql

The npm package does not ship the SDL, so it is vendored here. It is only used
by `test/schema.test.ts`, which validates every query and mutation in
`src/queries.ts` against it. Never use the stale `main` branch of linear/linear
(SDK 75); `master` is the live branch.

To update, download the file at the newest SDK tag, then run the linear tests
and fix any query the new schema rejects.
