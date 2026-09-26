const KV = 'CURATOR_ERROR_RECORDS';

export function authorizeRecoveryExport(request, env) {
  if (!env.RECOVERY_EXPORT_TOKEN) {
    return json({
      ok: false,
      error: 'Recovery export is disabled because RECOVERY_EXPORT_TOKEN is not configured.'
    }, 503);
  }

  const supplied = request.headers.get('x-curator-recovery-key');
  return supplied === env.RECOVERY_EXPORT_TOKEN
    ? null
    : json({ ok: false, error: 'Unauthorized recovery export request.' }, 401);
}

export async function recoveryExport(env) {
  try {
    const entries = await listAllErrorState(env);
    const data = { entries };
    const exportedAt = new Date().toISOString();
    const dataSha256 = await sha256Text(JSON.stringify(data));

    const payload = {
      format: 'curator-error-bus-kv-recovery',
      schemaVersion: 1,
      exportedAt,
      source: {
        service: 'CuratorOS Error Bus',
        binding: KV,
        namespaceId: '447306da3a754b44830d2ac8608322c0'
      },
      integrity: { algorithm: 'SHA-256', dataSha256 },
      summary: {
        keyCount: entries.length,
        categories: summarizeErrorState(entries)
      },
      data
    };

    const stamp = exportedAt.replace(/[:.]/g, '-');
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="error-bus-recovery-${stamp}.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex, nofollow, noarchive'
      }
    });
  } catch (error) {
    return json({
      ok: false,
      error: 'Recovery export failed.',
      detail: error instanceof Error ? error.message : String(error)
    }, 500);
  }
}

async function listAllErrorState(env) {
  requireKv(env);

  const entries = [];
  let cursor;

  do {
    const page = await env[KV].list({
      limit: 1000,
      ...(cursor ? { cursor } : {})
    });

    for (const item of page.keys) {
      const raw = await env[KV].get(item.name, 'text');
      if (raw === null) throw new Error(`Listed KV key disappeared during export: ${item.name}`);
      entries.push({ key: item.name, value: raw });
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

function summarizeErrorState(entries) {
  const counts = {
    incidents: 0,
    events: 0,
    heartbeats: 0,
    observations: 0,
    maintenance: 0,
    other: 0
  };

  for (const { key } of entries) {
    if (key.startsWith('incident:')) counts.incidents++;
    else if (key.startsWith('event:')) counts.events++;
    else if (key.startsWith('heartbeat:')) counts.heartbeats++;
    else if (key.startsWith('observation:')) counts.observations++;
    else if (key.startsWith('maintenance:')) counts.maintenance++;
    else counts.other++;
  }

  return counts;
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive'
    }
  });
}
