# RexCapital – Pipedrive Lead API

A small, production-ready serverless backend that receives landing-page form
submissions and creates a **Person** and a **Deal** in [Pipedrive](https://www.pipedrive.com/) CRM.

The Pipedrive API token stays server-side only — it is **never** exposed to the frontend.

## Architecture

```
Browser (HTML form)  ──POST──►  /api/lead  (Vercel serverless function)
                                     │
                                     ├─► POST /v1/persons   (create Person)
                                     └─► POST /v1/deals      (create Deal, linked to Person)
```

- Runtime: **Node.js** (ES Modules) on **Vercel Serverless Functions**.
- HTTP client: **Axios**.
- CORS is enabled (`POST`, `OPTIONS`) because the frontend is hosted separately.
- All configurable values (field keys, enum option IDs, stage ID) live in a single
  config block at the top of `api/lead.js`.

## Project structure

```
/
├── api/
│   └── lead.js        # The serverless function -> POST /api/lead
├── package.json
├── .env.example
├── vercel.json
└── README.md
```

## Configuration you must complete

Open `api/lead.js` and fill in the values marked with `// TODO`:

1. **`FIELD_KEYS.registros_publicos`** – the 40-char custom field key for
   `registros_publicos`. Find it under
   *Settings → Company settings → Data fields*, or via the API endpoint
   `GET /v1/personFields` (or `/v1/dealFields`).
2. **`ciudadOptions`** – the numeric option ID for each city
   (`Lima`, `Arequipa`, …). Pipedrive enum fields require option IDs, not labels.

Already set for you:

- `ciudad_inmueble` field key: `fd91b8a1f73a20634e912b3a41736a40478aa9c`
- `registros_publicos` options: `"Si" → 37`, `"No" → 38`
- Deal stage ("Nuevos leads"): `stage_id = 6`

> **Note on custom field mapping:** Pipedrive `enum` fields do not accept label
> text — they require the numeric **option ID**. The mapping objects
> (`registrosPublicosOptions`, `ciudadOptions`) translate incoming labels into
> those IDs. `FIELD_TARGET` controls whether each field is attached to the
> Person or the Deal.

## Install dependencies

```bash
npm install
```

## Configure environment variables

Copy the example file and add your token:

```bash
cp .env.example .env
```

Then edit `.env`:

```
PIPEDRIVE_TOKEN=your_real_pipedrive_api_token
```

Your token is in Pipedrive under *Settings → Personal preferences → API*.

## Run locally

Uses the Vercel CLI to emulate the serverless environment:

```bash
npm run dev
```

This serves the function at:

```
http://localhost:3000/api/lead
```

`vercel dev` automatically loads variables from your local `.env`.

## Deploy to Vercel

1. Install the CLI (if needed) and log in:

   ```bash
   npm i -g vercel
   vercel login
   ```

2. Add the environment variable to your Vercel project:

   ```bash
   vercel env add PIPEDRIVE_TOKEN
   ```

   (Or set it in the Vercel dashboard: *Project → Settings → Environment Variables*.)

3. Deploy:

   ```bash
   npm run deploy
   ```

   Vercel automatically routes `api/lead.js` to `/api/lead`.

## Test with curl

```bash
curl -X POST http://localhost:3000/api/lead \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Luis",
    "apellidos": "Perez",
    "whatsapp": "999111222",
    "email": "test@example.com",
    "registros_publicos": "Si",
    "ciudad_inmueble": "Lima"
  }'
```

### Success response

```json
{
  "success": true,
  "personId": 123,
  "dealId": 456
}
```

### Error response

```json
{
  "success": false,
  "message": "error description"
}
```

## API reference

### `POST /api/lead`

**Request body**

| Field                | Type   | Required | Notes                                   |
| -------------------- | ------ | -------- | --------------------------------------- |
| `nombre`             | string | yes      | First name                              |
| `apellidos`          | string | yes      | Last name(s)                            |
| `whatsapp`           | string | yes      | Phone number                            |
| `email`              | string | yes      | Email address                           |
| `registros_publicos` | string | yes      | Enum label (`"Si"` / `"No"`)            |
| `ciudad_inmueble`    | string | yes      | City label (must exist in `ciudadOptions`) |

**Responses**

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| 200    | Person and Deal created                             |
| 400    | Validation error (missing field or unmapped option) |
| 405    | Method not allowed (only `POST` / `OPTIONS`)        |
| 500    | Server misconfiguration (missing token)             |
| 502    | Pipedrive responded without expected data           |
| 4xx/5xx| Propagated Pipedrive error                          |

## Security notes

- The Pipedrive token is read from `process.env.PIPEDRIVE_TOKEN` and never sent
  to the client.
- Error responses surface Pipedrive's message for debugging but never expose
  environment variables or the token.
- `.env` is git-ignored; only `.env.example` is committed.
