import axios from 'axios';

/* -------------------------------------------------------------------------- */
/*  CONFIGURATION LAYER                                                        */
/*                                                                            */
/*  Fill in board/column/group IDs from Monday (API playground or Developer   */
/*  mode). Secrets come from environment variables — never hardcode tokens.   */
/* -------------------------------------------------------------------------- */

// Monday GraphQL API (single endpoint for all operations).
const MONDAY_API_URL = 'https://api.monday.com/v2';

/**
 * Board / group IDs.
 *
 * Board ID: open the board URL → /boards/XXXXXXXX
 * Group ID: API playground → boards { groups { id title } }
 *           "Leads nuevos" is the pipeline stage for new qualified deals.
 */
const BOARDS = {
  // TODO: paste Contactos board ID
  contactos: process.env.MONDAY_CONTACTOS_BOARD_ID || 'CONTACTOS_BOARD_ID',
  // TODO: paste Acuerdos board ID
  acuerdos: process.env.MONDAY_ACUERDOS_BOARD_ID || 'ACUERDOS_BOARD_ID',
};

const GROUPS = {
  // Main table group for active deals ("Acuerdos activos" → id is usually "topics").
  // Pipeline stages like "Leads nuevos" are a Status column, not this group id.
  acuerdosActivos: process.env.MONDAY_ACUERDOS_ACTIVOS_GROUP_ID || 'topics',
};

/**
 * Column IDs on each board.
 *
 * Dropdown/status columns in Monday accept LABEL TEXT (not Pipedrive option IDs).
 * Get IDs via API playground:
 *   query {
 *     boards(ids: [18424940103]) {
 *       columns { id title type }
 *     }
 *   }
 * Match title "ciudad_inmueble" / "registros_publicos" → copy each "id".
 */
const COLUMNS = {
  contactos: {
    // Email / phone on Contactos (often "email" / "phone" / "contact_email")
    email: process.env.MONDAY_CONTACTOS_EMAIL_COLUMN || 'email',
    phone: process.env.MONDAY_CONTACTOS_PHONE_COLUMN || 'phone',
    // Optional — only if you also created these columns on Contactos
    ciudadInmueble: process.env.MONDAY_CONTACTOS_CIUDAD_INMUEBLE_COLUMN || null,
    registrosPublicos: process.env.MONDAY_CONTACTOS_REGISTROS_PUBLICOS_COLUMN || null,
  },
  acuerdos: {
    // Required custom fields on Acuerdos (same names as Pipedrive / form)
    ciudadInmueble:
      process.env.MONDAY_ACUERDOS_CIUDAD_INMUEBLE_COLUMN || 'CIUDAD_INMUEBLE_COLUMN_ID',
    registrosPublicos:
      process.env.MONDAY_ACUERDOS_REGISTROS_PUBLICOS_COLUMN || 'REGISTROS_PUBLICOS_COLUMN_ID',
    // Optional — board relation / connect column linking Acuerdos → Contactos
    contactRelation: process.env.MONDAY_ACUERDOS_CONTACT_COLUMN || null,
  },
};

/**
 * QUALIFICATION RULES (same as before / HighLevel behavior)
 *
 * ALL leads → create Contact (Contactos board). Visible under Contactos.
 * ONLY qualified → also create Deal (Acuerdos) in "Leads nuevos" group
 *                 (this is what appears in the pipeline/embudo).
 */
const QUALIFICATION = {
  requiredRegistrosPublicos: 'Si',
  cities: ['Lima', 'Callao', 'Arequipa'],
};

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function normalizeLabel(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isQualified(registrosPublicos, ciudad) {
  const registrosOk =
    normalizeLabel(registrosPublicos) ===
    normalizeLabel(QUALIFICATION.requiredRegistrosPublicos);
  const cityOk = QUALIFICATION.cities
    .map(normalizeLabel)
    .includes(normalizeLabel(ciudad));
  return registrosOk && cityOk;
}

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

/**
 * Normalize "Si"/"Sí"/"No" for Monday dropdown/status labels.
 * Prefer exact labels that match what you configured in Monday.
 */
function normalizeRegistrosLabel(value) {
  const n = normalizeLabel(value);
  if (n === 'si') return 'Si';
  if (n === 'no') return 'No';
  return String(value).trim();
}

/**
 * Build Monday column_values object for dropdown / email / phone / numbers.
 * Dropdown columns use { labels: ["Lima"] }.
 * Status columns use { label: "Si" } — if a column is status, switch the helper.
 */
function buildColumnValues({
  email,
  phone,
  ciudad,
  registros,
  contactItemId,
  columns,
  columnTypes = {},
}) {
  const values = {};

  if (columns.email && email) {
    values[columns.email] = {
      email,
      text: email,
    };
  }

  if (columns.phone && phone) {
    values[columns.phone] = {
      phone: String(phone),
      countryShortName: 'PE',
    };
  }

  if (columns.ciudadInmueble && ciudad) {
    const type = columnTypes.ciudadInmueble || 'dropdown';
    values[columns.ciudadInmueble] =
      type === 'status' ? { label: ciudad } : { labels: [ciudad] };
  }

  if (columns.registrosPublicos && registros) {
    const label = normalizeRegistrosLabel(registros);
    const type = columnTypes.registrosPublicos || 'dropdown';
    values[columns.registrosPublicos] =
      type === 'status' ? { label } : { labels: [label] };
  }

  if (columns.contactRelation && contactItemId) {
    values[columns.contactRelation] = {
      item_ids: [Number(contactItemId)],
    };
  }

  return values;
}

async function mondayRequest(token, query, variables = {}) {
  const response = await axios.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'API-Version': '2024-10',
      },
      timeout: 15000,
    }
  );

  // Monday returns GraphQL errors with HTTP 200 — surface them as failures.
  if (response.data?.errors?.length) {
    const message = response.data.errors.map((e) => e.message).join('; ');
    const err = new Error(message);
    err.mondayErrors = response.data.errors;
    err.status = 502;
    throw err;
  }

  return response.data?.data;
}

async function createMondayItem({
  token,
  boardId,
  groupId,
  itemName,
  columnValues,
}) {
  // group_id is only used for deals entering a pipeline stage ("Leads nuevos").
  const mutation = groupId
    ? `
      mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id: $boardId,
          group_id: $groupId,
          item_name: $itemName,
          column_values: $columnValues
        ) { id }
      }
    `
    : `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id: $boardId,
          item_name: $itemName,
          column_values: $columnValues
        ) { id }
      }
    `;

  const variables = {
    boardId: String(boardId),
    itemName,
    columnValues: JSON.stringify(columnValues),
  };

  if (groupId) {
    variables.groupId = String(groupId);
  }

  const data = await mondayRequest(token, mutation, variables);
  return data?.create_item?.id;
}

/* -------------------------------------------------------------------------- */
/*  HANDLER                                                                    */
/* -------------------------------------------------------------------------- */

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, {
      success: false,
      message: 'Method not allowed. Use POST.',
    });
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return sendJson(res, 500, {
      success: false,
      message: 'Server misconfiguration: missing Monday credentials.',
    });
  }

  const body = parseBody(req.body);

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

  const qualified = isQualified(registros_publicos, ciudad_inmueble);
  const fullName = `${nombre} ${apellidos}`.trim();

  try {
    // 1. ALWAYS create a Contact (Contactos) — qualified or not.
    const contactColumns = buildColumnValues({
      email,
      phone: whatsapp,
      ciudad: ciudad_inmueble,
      registros: registros_publicos,
      columns: COLUMNS.contactos,
    });

    const contactId = await createMondayItem({
      token,
      boardId: BOARDS.contactos,
      itemName: fullName,
      columnValues: contactColumns,
    });

    if (!contactId) {
      return sendJson(res, 502, {
        success: false,
        message: 'Monday did not return a contact item ID.',
      });
    }

    // 2. Non-qualified: saved on Contactos only — do NOT enter Acuerdos pipeline.
    if (!qualified) {
      return sendJson(res, 200, {
        success: true,
        qualified: false,
        contactId,
      });
    }

    // 3. Qualified: also create Deal on Acuerdos in "Leads nuevos".
    const dealColumns = buildColumnValues({
      ciudad: ciudad_inmueble,
      registros: registros_publicos,
      contactItemId: contactId,
      columns: COLUMNS.acuerdos,
    });

    const dealId = await createMondayItem({
      token,
      boardId: BOARDS.acuerdos,
      groupId: GROUPS.acuerdosActivos,
      itemName: `Lead - ${fullName}`,
      columnValues: dealColumns,
    });

    if (!dealId) {
      return sendJson(res, 502, {
        success: false,
        message: 'Contact created but Monday did not return a deal item ID.',
        contactId,
      });
    }

    return sendJson(res, 200, {
      success: true,
      qualified: true,
      contactId,
      dealId,
    });
  } catch (error) {
    const status = error.response?.status || error.status || 500;
    const mondayMessage =
      error.mondayErrors?.map((e) => e.message).join('; ') ||
      error.response?.data?.errors?.map((e) => e.message).join('; ') ||
      error.response?.data?.error_message ||
      error.message ||
      'Unknown error contacting Monday.';

    console.error('Monday request failed:', {
      status,
      message: mondayMessage,
    });

    return sendJson(res, status >= 400 && status < 600 ? status : 500, {
      success: false,
      message: `Monday error: ${mondayMessage}`,
    });
  }
}
