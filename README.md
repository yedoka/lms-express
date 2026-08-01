# skillbase-express

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Environment variables

Set these variables before running the server:

- `PORT` (example: `3000`)
- `CLIENT_URL` (example: `http://localhost:5173`)

Example (PowerShell):

```powershell
$env:PORT="3000"
$env:CLIENT_URL="http://localhost:5173"
bun .\index.ts
```
