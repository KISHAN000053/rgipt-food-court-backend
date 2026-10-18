# Contributing

Thanks for helping improve Campus Food Court.

## Before changing code

- Read [the API reference](docs/API.md) and [operations guide](docs/OPERATIONS.md).
- Keep campus-specific values configurable where practical; mark legacy one-campus migrations clearly.
- Do not add real secrets, customer data, database dumps, or production payment details.
- Never treat frontend checks as a substitute for backend authorization.

## Local checks

```bash
npm ci
npm test
```

GitHub Actions also checks JavaScript syntax on pushes and pull requests. For payment, authentication, database, or Socket.IO changes, document manual integration checks that still need to be performed.

## Pull requests

Include the problem being solved, behavior changes, configuration/migration notes, test evidence, and any known limitations. Avoid unrelated refactors in payment/refund paths. Do not claim end-to-end coverage unless you actually ran it against the relevant integrations.
