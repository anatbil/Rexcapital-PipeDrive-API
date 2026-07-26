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
 * CUSTOM FIELD MAP
 *
 * In this Pipedrive account the same questions exist as BOTH a Person field
 * and a Deal field, and each version has its OWN 40-char key and its OWN set
 * of numeric option IDs. Pipedrive "enum" fields require the numeric option
 * ID, never the label text.
 *
 * Structure: fieldName -> { entity -> { key, options } }
 *   - Writing to an entity is opt-in: if you don't want a field on the Person
 *     (or Deal), delete that entity block.
 *   - Option keys below are stored normalized (lowercase, no accents). Lookups
 *     are accent/case-insensitive, so "Si"/"Sí" and "Huanuco"/"Huánuco" match.
 *
 * NOTE: the PERSON "ciudad_inmueble" field currently has only 3 options
 * configured in Pipedrive (Amazonas, Áncash, Apurímac). Any other city cannot
 * be stored on the Person until you add the missing options in Pipedrive and
 * extend the map below. The DEAL version already has all 25 regions.
 */
const CUSTOM_FIELDS = {
  registros_publicos: {
    person: {
      key: 'bd5402559c03380c0bae3b292555fcae222310cd',
      options: { si: 32, no: 33 },
    },
    deal: {
      key: '4eb07573750fc966bc856de7f8e5fdb926d691dd',
      options: { si: 37, no: 38 },
    },
  },
  ciudad_inmueble: {
    person: {
      key: '9f2ef74ec85fda3fa28a22b55da07edc2414f0bb',
      options: {
        amazonas: 34, ancash: 35, apurimac: 36, arequipa: 64, ayacucho: 65,
        cajamarca: 66, callao: 67, cusco: 68, huancavelica: 69, huanuco: 70,
        ica: 71, junin: 72, 'la libertad': 73, lambayeque: 74, lima: 75,
        loreto: 76, 'madre de dios': 77, moquegua: 78, pasco: 79, piura: 80,
        puno: 81, 'san martin': 82, tacna: 83, tumbes: 84, ucayali: 85,
      },
    },
    deal: {
      key: 'fd91b8aa1f73a20634e912b3a41736a40478aa9c',
      options: {
        amazonas: 39, ancash: 40, apurimac: 41, arequipa: 42, ayacucho: 43,
        cajamarca: 44, callao: 45, cusco: 46, huancavelica: 47, huanuco: 48,
        ica: 49, junin: 50, 'la libertad': 51, lambayeque: 52, lima: 53,
        loreto: 54, 'madre de dios': 55, moquegua: 56, pasco: 57, piura: 58,
        puno: 59, 'san martin': 60, tacna: 61, tumbes: 62, ucayali: 63,
      },
    },
  },
};

/**
 * The entity that MUST accept every enum value (source of truth). If a value
 * cannot be mapped for this entity, the request fails with 400. Other entities
 * are best-effort: unmapped values are simply skipped (and logged), so an
 * incomplete Person field never blocks lead creation.
 */
const PRIMARY_ENTITY = 'deal';

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
 * Normalize a label for lookup: strip diacritics, trim, lowercase.
 * "Sí" -> "si", "Huánuco" -> "huanuco", "La Libertad" -> "la libertad".
 */
function normalizeLabel(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolve an incoming label to the numeric option ID for a given field/entity.
 * Returns undefined when the value is not mapped for that entity.
 */
function resolveOptionId(fieldName, entity, value) {
  const cfg = CUSTOM_FIELDS[fieldName]?.[entity];
  if (!cfg) return undefined;
  return cfg.options[normalizeLabel(value)];
}

/**
 * Attach every configured custom field for one entity onto its payload.
 * Best-effort: values that can't be mapped for this entity are skipped and
 * returned as warnings (so a partially-configured field never breaks the flow).
 */
function attachCustomFields(payload, entity, values) {
  const warnings = [];
  for (const [fieldName, entityMap] of Object.entries(CUSTOM_FIELDS)) {
    const cfg = entityMap[entity];
    if (!cfg) continue;
    const optionId = resolveOptionId(fieldName, entity, values[fieldName]);
    if (optionId === undefined) {
      warnings.push(`${entity}.${fieldName}="${values[fieldName]}" is not mapped; skipped`);
      continue;
    }
    payload[cfg.key] = optionId;
  }
  return warnings;
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

  // 2. Validate enum values against the PRIMARY entity (source of truth).
  const enumValues = { registros_publicos, ciudad_inmueble };
  for (const fieldName of Object.keys(CUSTOM_FIELDS)) {
    if (!CUSTOM_FIELDS[fieldName][PRIMARY_ENTITY]) continue;
    if (resolveOptionId(fieldName, PRIMARY_ENTITY, enumValues[fieldName]) === undefined) {
      return sendJson(res, 400, {
        success: false,
        message: `Invalid value for "${fieldName}": "${enumValues[fieldName]}". It is not a configured option.`,
      });
    }
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

    // Attach person-scoped custom fields (best-effort per entity).
    const personWarnings = attachCustomFields(personPayload, 'person', enumValues);
    if (personWarnings.length) {
      console.warn('Person custom-field warnings:', personWarnings);
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

    // Attach deal-scoped custom fields (best-effort per entity).
    const dealWarnings = attachCustomFields(dealPayload, 'deal', enumValues);
    if (dealWarnings.length) {
      console.warn('Deal custom-field warnings:', dealWarnings);
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
