# Web Project Runtime

`web-project-runtime` is the public runtime/tooling companion for [`EliteMay/web-project-guide`](https://github.com/EliteMay/web-project-guide).

It contains reusable execution code, schemas, tests, and CI for Loop Engineering and related runtime primitives.

## Repository roles

- `web-project-guide` — common rules, product contracts, routing, and quality standards
- `web-project-runtime` — reusable public runtime code, schemas, tests, and CI
- `web-project-data` — private conversations, work queues, loop run evidence, recovery data, and other project-specific/private state
- each target project repository — current project requirements, code, data, and implementation state

This repository must not contain private conversations, real work-queue contents, secrets, recovery capsules, private evidence, or project-specific current state.

## Current status

Runtime migration is in progress. Loop Engineering Phase A–E will be migrated from `web-project-data` and validated here before this repository becomes the canonical runtime owner.
