import axios from 'axios';

/* -------------------------------------------------------------------------- */
/*  CONFIGURATION LAYER                                                        */
/*                                                                            */
/*  Everything you may need to update over time lives in this block so you    */
/*  never have to touch the request logic below.                              */
/* -------------------------------------------------------------------------- */

// Base URL for the Pipedrive REST API (v1).
const PIPEDRIVE_BASE_URL = 'https://api.pipedrive.com/v1';

// Deal stage where new leads land. "Nuevos leads" = 6.
const NEW_LEAD_STAGE_ID = 6;

/**
 * Custom field KEYS.
 *
 * Pipedrive identifies custom fields by a 40-char hash key, NOT by their
 * human-readable name. Fill these in from:
 *   Settings -> Company settings -> Data fields  (or the API /personFields
 *   and /dealFields endpoints).
 */
const FIELD_KEYS = {
  // TODO: INSERT the custom field key for "registros_publicos" here.
  registros_publicos: '4eb07573750fc966bc856de7f8e5fdb926d691dd',

  // Provided by you already:
  ciudad_inmueble: 'fd91b8aa1f73a20634e912b3a41736a40478aa9c',
};

/**
 * ENUM option mappings.
 *
 * Pipedrive "enum" (single-option) custom fields do NOT accept the label
 * text. They require the numeric OPTION ID. Map every possible incoming
 * label to its option ID here.
 */
const registrosPublicosOptions = {
  Si: 'Si',
  No: 'No',
};

/**
 * City -> option ID mapping. Add new cities here as you configure them in
 * Pipedrive. Replace each null with the real numeric option ID.
 */
const ciudadOptions = {
  // TODO: INSERT option IDs for each city.
  "Amazonas": "Amazonas",
  "Áncash": "Áncash",
  "Apurímac": "Apurímac",
  "Arequipa": "Arequipa",
  "Ayacucho": "Ayacucho",
  "Cajamarca": "Cajamarca",
  "Callao": "Callao",
  "Cusco": "Cusco",
  "Huancavelica": "Huancavelica",
  "Huánuco": "Huánuco",
  "Ica": "Ica",
  "Junín": "Junín",
  "La Libertad": "La Libertad",
  "Lambayeque": "Lambayeque",
  "Lima": "Lima",
  "Loreto": "Loreto",
  "Madre de Dios": "Madre de Dios",
  "Moquegua": "Moquegua",
  "Pasco": "Pasco",
  "Piura": "Piura",
  "Puno": "Puno",
  "San Martín": "San Martín",
  "Tacna": "Tacna",
  "Tumbes": "Tumbes",
  "Ucayali": "Ucayali",
};

/**
 * Which entity each custom field belongs to.
 * Change "person" / "deal" here if you attach a field to the other entity.
 */
const FIELD_TARGET = {
  registros_publicos: 'person',
  ciudad_inmueble: 'deal',
};

// Required fields expected from the frontend.
const REQUIRED_FIELDS = [
  'nombre',
  'apellidos',
  'whatsapp',
  'email',
  'registros_publicos',
  'ciudad_inmueble',
];

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function setCorsHeaders(res) {
  // Frontend is hosted separately, so we allow cross-origin requests.
  // Tighten "*" to your specific domain in production if you prefer.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

/**
 * Some serverless setups deliver the body as a raw string. Normalize it to
 * an object so validation works regardless of how it arrives.
 */
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/*  HANDLER                                                                    */
/* -------------------------------------------------------------------------- */

export default async function handler(req, res) {
  setCorsHeaders(res);

  // Answer CORS preflight requests.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only POST is accepted for creating leads.
  if (req.method !== 'POST') {
    return sendJson(res, 405, {
      success: false,
      message: 'Method not allowed. Use POST.',
    });
  }

  // The token must exist server-side. We never expose it to the client.
  const token = process.env.PIPEDRIVE_TOKEN;
  if (!token) {
    return sendJson(res, 500, {
      success: false,
      message: 'Server misconfiguration: missing Pipedrive credentials.',
    });
  }

  const body = parseBody(req.body);

  // 1. Validate required fields.
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = body[field];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    return sendJson(res, 400, {
      success: false,
      message: `Missing required field(s): ${missing.join(', ')}.`,
    });
  }

  const {
    nombre,
    apellidos,
    whatsapp,
    email,
    registros_publicos,
    ciudad_inmueble,
  } = body;

  // 2. Resolve enum labels -> option IDs.
  const registrosOptionId = registrosPublicosOptions[registros_publicos];
  if (registrosOptionId === undefined) {
    return sendJson(res, 400, {
      success: false,
      message: `Invalid value for "registros_publicos": "${registros_publicos}". Allowed: ${Object.keys(
        registrosPublicosOptions
      ).join(', ')}.`,
    });
  }

  const ciudadOptionId = ciudadOptions[ciudad_inmueble];
  if (ciudadOptionId === undefined || ciudadOptionId === null) {
    return sendJson(res, 400, {
      success: false,
      message: `Unmapped or missing option ID for "ciudad_inmueble": "${ciudad_inmueble}". Add it to ciudadOptions.`,
    });
  }

  const fullName = `${nombre} ${apellidos}`.trim();

  // Axios client preconfigured with base URL and the token query param.
  const pipedrive = axios.create({
    baseURL: PIPEDRIVE_BASE_URL,
    params: { api_token: token },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  try {
    // 3. Build and create the Person.
    const personPayload = {
      name: fullName,
      email: [{ value: email, primary: true }],
      phone: [{ value: whatsapp, primary: true }],
    };

    // Attach person-scoped custom fields.
    if (FIELD_TARGET.registros_publicos === 'person') {
      personPayload[FIELD_KEYS.registros_publicos] = registrosOptionId;
    }
    if (FIELD_TARGET.ciudad_inmueble === 'person') {
      personPayload[FIELD_KEYS.ciudad_inmueble] = ciudadOptionId;
    }

    const personRes = await pipedrive.post('/persons', personPayload);
    const personId = personRes.data?.data?.id;

    if (!personId) {
      return sendJson(res, 502, {
        success: false,
        message: 'Pipedrive did not return a person ID.',
      });
    }

    // 4. Build and create the Deal.
    const dealPayload = {
      title: `Lead - ${fullName}`,
      person_id: personId,
      stage_id: NEW_LEAD_STAGE_ID,
    };

    // Attach deal-scoped custom fields.
    if (FIELD_TARGET.registros_publicos === 'deal') {
      dealPayload[FIELD_KEYS.registros_publicos] = registrosOptionId;
    }
    if (FIELD_TARGET.ciudad_inmueble === 'deal') {
      dealPayload[FIELD_KEYS.ciudad_inmueble] = ciudadOptionId;
    }

    const dealRes = await pipedrive.post('/deals', dealPayload);
    const dealId = dealRes.data?.data?.id;

    if (!dealId) {
      return sendJson(res, 502, {
        success: false,
        message: 'Person created but Pipedrive did not return a deal ID.',
        personId,
      });
    }

    // 7. Clean success response.
    return sendJson(res, 200, {
      success: true,
      personId,
      dealId,
    });
  } catch (error) {
    // 8. Error handling. Surface useful Pipedrive info without leaking secrets.
    const status = error.response?.status || 500;
    const pipedriveMessage =
      error.response?.data?.error ||
      error.response?.data?.error_info ||
      error.message ||
      'Unknown error contacting Pipedrive.';

    // Never log or return the token or full env. Log only safe context.
    console.error('Pipedrive request failed:', {
      status,
      message: pipedriveMessage,
    });

    return sendJson(res, status >= 400 && status < 600 ? status : 500, {
      success: false,
      message: `Pipedrive error: ${pipedriveMessage}`,
    });
  }
}
