const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
};
const PIN = { daniel: '1313', marco: '2424', enzo: '3535', hector: '4646' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function auth(req) {
  const h = req.headers.get('Authorization') || '';
  const token = h.replace(/^(Bearer|Basic)\s+/i, '');
  if (!token) return null;
  try {
    const [user, pin] = atob(token).split(':');
    if (PIN[user] === pin) return user;
  } catch(e) {}
  return null;
}


function getD1(env) {
  return env.HF_DB || env.DB || env.HF_D1 || env.HECTOFLEX_DB || null;
}

async function ensurePushTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_user_id ON push_subscriptions(user_id)`).run();
}

function makeId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}



async function handleFetch(request, env) {
  try {
    const { HF_TASKS, HF_UPLOADS, PROJECT_DOCS } = env;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Login
    if (path === '/login' && request.method === 'POST') {
      const { user, pin } = await request.json();
      if (PIN[user] === pin) {
        return json({ ok: true, token: btoa(user + ':' + pin), user });
      }
      return json({ ok: false, error: 'PIN incorrect' }, 401);
    }

    // Files - allow token in query param
    const tokenParam = url.searchParams.get('token');
    let user = auth(request);
    if (!user && tokenParam) {
      try {
        const [u, p] = atob(tokenParam).split(':');
        if (PIN[u] === p) user = u;
      } catch(e) {}
    }

    // URL Shortener public routes
    if (path.startsWith('/r/') || path.startsWith('/vc/') || path.startsWith('/t/')) {
      const code = path.split('/')[2];
      if (!code) return json({ error: 'Not found' }, 404);
      if (path.startsWith('/r/')) {
        const target = await HF_TASKS.get('short:' + code);
        if (!target) return json({ error: 'Not found' }, 404);
        return Response.redirect(target, 302);
      }
      if (path.startsWith('/vc/')) {
        const vcard = await HF_TASKS.get('vcard:' + code);
        if (!vcard) return json({ error: 'Not found' }, 404);
        return new Response(vcard, { headers: { ...CORS, 'Content-Type': 'text/vcard', 'Content-Disposition': `attachment; filename="${code}.vcf"` } });
      }
      if (path.startsWith('/t/')) {
        const text = await HF_TASKS.get('text:' + code);
        if (!text) return json({ error: 'Not found' }, 404);
        return new Response(text, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }

    if (!user) return json({ error: 'Non autorisé' }, 401);


    // ===== PUSH SUBSCRIPTIONS (D1) =====
    if (path === '/push/subscribe' && request.method === 'POST') {
      const body = await request.json();
      const subscription = body && body.subscription;
      if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        return json({ error: 'Invalid subscription payload' }, 400);
      }
      const db = getD1(env);
      if (!db) return json({ error: 'D1 binding missing (HF_DB/DB/HF_D1/HECTOFLEX_DB)' }, 500);
      await ensurePushTable(db);
      const now = new Date().toISOString();
      const id = makeId();
      await db.prepare(`
        INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_id, user_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh=excluded.p256dh,
          auth=excluded.auth,
          user_id=excluded.user_id,
          user_name=excluded.user_name,
          updated_at=excluded.updated_at
      `)
      .bind(
        id,
        String(subscription.endpoint),
        String(subscription.keys.p256dh),
        String(subscription.keys.auth),
        body.user_id ? String(body.user_id) : user,
        body.user_name ? String(body.user_name) : user,
        now,
        now
      ).run();
      return json({ ok: true });
    }

    if (path === '/push/unsubscribe' && request.method === 'POST') {
      const body = await request.json();
      const endpoint = body && body.endpoint;
      if (!endpoint) return json({ error: 'endpoint required' }, 400);
      const db = getD1(env);
      if (!db) return json({ error: 'D1 binding missing (HF_DB/DB/HF_D1/HECTOFLEX_DB)' }, 500);
      await ensurePushTable(db);
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(String(endpoint)).run();
      return json({ ok: true });
    }

    // Admin export for n8n/cron sender (WebPush send can be done outside worker)
    if (path === '/push/subscriptions' && request.method === 'GET') {
      const db = getD1(env);
      if (!db) return json({ error: 'D1 binding missing (HF_DB/DB/HF_D1/HECTOFLEX_DB)' }, 500);
      await ensurePushTable(db);
      const userId = url.searchParams.get('user_id');
      const apiKey = request.headers.get('x-api-key');
      if (env.PUSH_ADMIN_KEY && apiKey !== env.PUSH_ADMIN_KEY) return json({ error: 'Unauthorized' }, 401);
      let q = 'SELECT endpoint,p256dh,auth,user_id,user_name,updated_at FROM push_subscriptions';
      let stmt;
      if (userId) stmt = db.prepare(q + ' WHERE user_id = ? ORDER BY updated_at DESC').bind(userId);
      else stmt = db.prepare(q + ' ORDER BY updated_at DESC LIMIT 500');
      const rows = await stmt.all();
      return json({ ok: true, subscriptions: rows.results || [] });
    }
    // GET /tasks
    if (path === '/tasks' && request.method === 'GET') {
      const list = url.searchParams.get('list') || 'personal';
      const key = list === 'shared' ? 'tasks:shared' : `tasks:${user}`;
      const data = await HF_TASKS.get(key, 'json') || [];
      return json(data);
    }

    // POST /tasks
    if (path === '/tasks' && request.method === 'POST') {
      const body = await request.json();
      const list = body.list || 'personal';
      const key = list === 'shared' ? 'tasks:shared' : `tasks:${user}`;
      const tasks = await HF_TASKS.get(key, 'json') || [];
      const task = {
        id: Date.now(),
        text: body.text || body.title || '',
        done: false,
        urgent: body.priority === 'high' || false,
        note: body.note || '',
        category: body.category || '',
        created_by: user,
        created_at: new Date().toISOString()
      };
      tasks.unshift(task);
      await HF_TASKS.put(key, JSON.stringify(tasks));
      return json(task);
    }

    // PUT /tasks/:id
    if (path.startsWith('/tasks/') && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const list = body.list || 'personal';
      const key = list === 'shared' ? 'tasks:shared' : `tasks:${user}`;
      const tasks = await HF_TASKS.get(key, 'json') || [];
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return json({ error: 'Not found' }, 404);
      Object.assign(tasks[idx], body.updates || {});
      await HF_TASKS.put(key, JSON.stringify(tasks));
      return json(tasks[idx]);
    }

    // DELETE /tasks/:id
    if (path.startsWith('/tasks/') && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      const list = url.searchParams.get('list') || 'personal';
      const key = list === 'shared' ? 'tasks:shared' : `tasks:${user}`;
      let tasks = await HF_TASKS.get(key, 'json') || [];
      tasks = tasks.filter(t => t.id !== id);
      await HF_TASKS.put(key, JSON.stringify(tasks));
      return json({ ok: true });
    }


    // GET /projects
    if (path === '/projects' && request.method === 'GET') {
      const data = await HF_TASKS.get('projects:shared', 'json') || [];
      return json(data);
    }

    // POST /projects
    if (path === '/projects' && request.method === 'POST') {
      const body = await request.json();
      const projects = await HF_TASKS.get('projects:shared', 'json') || [];
      const project = {
        id: Date.now(),
        name: body.name || '',
        client: body.client || '',
        contact: body.contact || '',
        montant: body.montant || '',
        deadline: body.deadline || '',
        dept: body.dept || '',
        description: body.description || '',
        source: body.source || '',
        phone: body.phone || '',
        email: body.email || '',
        priority: body.priority || 0,
        note: body.note || '',
        notes: body.notes || '',
        statut: body.statut || 'en_attente',
        checklist: body.checklist || [],
        created_by: user,
        created_at: new Date().toISOString()
      };
      projects.unshift(project);
      await HF_TASKS.put('projects:shared', JSON.stringify(projects));
      return json(project);
    }

    // PUT /projects/:id
    if (path.startsWith('/projects/') && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const projects = await HF_TASKS.get('projects:shared', 'json') || [];
      const idx = projects.findIndex(p => p.id === id);
      if (idx === -1) return json({ error: 'Not found' }, 404);
      Object.assign(projects[idx], body);
      await HF_TASKS.put('projects:shared', JSON.stringify(projects));
      return json(projects[idx]);
    }

    // DELETE /projects/:id
    if (path.startsWith('/projects/') && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let projects = await HF_TASKS.get('projects:shared', 'json') || [];
      projects = projects.filter(p => p.id !== id);
      await HF_TASKS.put('projects:shared', JSON.stringify(projects));
      return json({ ok: true });
    }

    // URL Shortener
    if (path === '/shorten' && request.method === 'POST') {
      const body = await request.json();
      const code = body.code || Math.random().toString(36).slice(2, 8);
      if (body.url) await HF_TASKS.put('short:' + code, body.url);
      if (body.vcard) await HF_TASKS.put('vcard:' + code, body.vcard);
      if (body.text) await HF_TASKS.put('text:' + code, body.text);
      return json({ ok: true, code, url: url.origin + '/r/' + code });
    }

    if (path === '/shorten' && request.method === 'GET') {
      const list = await HF_TASKS.list({ prefix: 'short:' });
      const items = list.keys.map(k => ({ code: k.name.replace('short:', ''), type: 'redirect' }));
      return json(items);
    }

    
    // ===== PROJECT FILES (R2) =====
    var fileMatch = path.match(/^\/projects\/(\d+)\/files(?:\/(\d+))?$/);
    if (fileMatch) {
      var projId = fileMatch[1];
      var fileIdx = fileMatch[2];
      
      // POST /projects/:id/files — upload
      if (request.method === 'POST' && !fileIdx) {
        try {
          var ct = request.headers.get('content-type') || '';
          var buf, fname, ftype;
          if (ct.includes('application/json')) {
            var body = await request.json();
            var b64 = body.data;
            fname = body.filename || 'file';
            ftype = body.type || 'application/octet-stream';
            var binary = atob(b64);
            var bytes = new Uint8Array(binary.length);
            for (var i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
            buf = bytes.buffer;
          } else {
            var fd = await request.formData();
            var file = fd.get('file');
            if (!file) return json({error:'No file'}, 400);
            if (typeof file === 'string') {
              buf = new TextEncoder().encode(file);
              fname = fd.get('filename') || 'file';
              ftype = 'application/octet-stream';
            } else {
              buf = await file.arrayBuffer();
              fname = file.name || 'file';
              ftype = file.type || 'application/octet-stream';
            }
          }
          var fsize = buf.byteLength;
          var projects = await HF_TASKS.get('projects:shared', 'json') || [];
          var proj = projects.find(function(p){return String(p.id)===projId});
          if (!proj) return json({error:'Project not found'}, 404);
          if (!proj.documents) proj.documents = [];
          var key = 'proj-' + projId + '/' + Date.now() + '-' + fname;
          await PROJECT_DOCS.put(key, buf, {httpMetadata:{contentType:ftype}});
          proj.documents.push({name:fname, key:key, type:ftype, size:fsize, uploaded:new Date().toISOString()});
          await HF_TASKS.put('projects:shared', JSON.stringify(projects));
          return json({ok:true, documents:proj.documents});
        } catch(uploadErr) { return json({error: 'Upload failed: ' + uploadErr.message}, 500); }
      }
      
      // GET /projects/:id/files/:idx — download
      if (request.method === 'GET' && fileIdx !== undefined) {
        var projects = await HF_TASKS.get('projects:shared', 'json') || [];
        var proj = projects.find(function(p){return String(p.id)===projId});
        if (!proj || !proj.documents || !proj.documents[parseInt(fileIdx)]) return json({error:'Not found'}, 404);
        var doc = proj.documents[parseInt(fileIdx)];
        var obj = await PROJECT_DOCS.get(doc.key);
        if (!obj) return json({error:'File not found in R2'}, 404);
        return new Response(obj.body, {headers:{'Content-Type':doc.type||'application/octet-stream','Content-Disposition':'inline; filename="'+doc.name+'"','Access-Control-Allow-Origin':'*'}});
      }
      
      // DELETE /projects/:id/files/:idx
      if (request.method === 'DELETE' && fileIdx !== undefined) {
        var projects = await HF_TASKS.get('projects:shared', 'json') || [];
        var proj = projects.find(function(p){return String(p.id)===projId});
        if (!proj || !proj.documents || !proj.documents[parseInt(fileIdx)]) return json({error:'Not found'}, 404);
        var doc = proj.documents[parseInt(fileIdx)];
        await PROJECT_DOCS.delete(doc.key);
        proj.documents.splice(parseInt(fileIdx), 1);
        await HF_TASKS.put('projects:shared', JSON.stringify(projects));
        return json({ok:true});
      }
    }

// ===== SUPPLIERS =====
    if (path === '/suppliers' && request.method === 'GET') {
      const data = await HF_TASKS.get('suppliers:shared', 'json') || [];
      return json(data);
    }
    if (path === '/suppliers' && request.method === 'POST') {
      const body = await request.json();
      const data = await HF_TASKS.get('suppliers:shared', 'json') || [];
      const supplier = { id: Date.now(), ...body, products: body.products||[], mySelections: body.mySelections||[], created_at: new Date().toISOString() };
      data.push(supplier);
      await HF_TASKS.put('suppliers:shared', JSON.stringify(data));
      return json(supplier);
    }
    var suppMatch = path.match(/^\/suppliers\/(\d+)$/);
    if (suppMatch && request.method === 'PUT') {
      const suppId = parseInt(suppMatch[1]);
      const body = await request.json();
      const data = await HF_TASKS.get('suppliers:shared', 'json') || [];
      const idx = data.findIndex(s => s.id === suppId);
      if (idx === -1) return json({error:'Not found'}, 404);
      Object.assign(data[idx], body);
      await HF_TASKS.put('suppliers:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (suppMatch && request.method === 'DELETE') {
      const suppId = parseInt(suppMatch[1]);
      let data = await HF_TASKS.get('suppliers:shared', 'json') || [];
      data = data.filter(s => s.id !== suppId);
      await HF_TASKS.put('suppliers:shared', JSON.stringify(data));
      return json({ok:true});
    }

    // Files (R2)
    if (path.startsWith('/files') && env.FILES) {
      const filePath = path.replace('/files/', '').replace('/files', '');
      
      if (path === '/files-list' && request.method === 'GET') {
        const listed = await env.FILES.list();
        return json(listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })));
      }

      if (request.method === 'PUT' && filePath) {
        const body = await request.arrayBuffer();
        await env.FILES.put(filePath, body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' } });
        return json({ ok: true, key: filePath });
      }

      if (request.method === 'GET' && filePath) {
        const obj = await env.FILES.get(filePath);
        if (!obj) return json({ error: 'Not found' }, 404);
        return new Response(obj.body, { headers: { ...CORS, 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream' } });
      }

      if (request.method === 'DELETE' && filePath) {
        await env.FILES.delete(filePath);
        return json({ ok: true });
      }
    }

    // Categories
    if (path === '/categories' && request.method === 'GET') {
      const cats = await HF_TASKS.get('categories', 'json') || ['Général','Marketing','Affaires','Production','Admin','Planning'];
      return json(cats);
    }

    if (path === '/categories' && request.method === 'POST') {
      const body = await request.json();
      let cats = await HF_TASKS.get('categories', 'json') || ['Général','Marketing','Affaires','Production','Admin','Planning'];
      if (body.name && !cats.includes(body.name)) cats.push(body.name);
      await HF_TASKS.put('categories', JSON.stringify(cats));
      return json(cats);
    }


    // === IMAGE UPLOAD ===
    if (path === '/upload' && request.method === 'POST') {
      if (!user) return json({ error: 'Non autorisé' }, 401);
      if (!HF_UPLOADS) return json({ error: 'HF_UPLOADS binding manquant' }, 500);
      const ct = request.headers.get('Content-Type') || '';
      if (!ct.includes('multipart/form-data') && !ct.startsWith('image/')) {
        return json({ error: 'Type non supporté' }, 400);
      }
      
      let fileData, fileName, mimeType;
      
      if (ct.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return json({ error: 'Fichier manquant' }, 400);
        fileData = await file.arrayBuffer();
        fileName = file.name || 'upload.jpg';
        mimeType = file.type || 'image/jpeg';
      } else {
        fileData = await request.arrayBuffer();
        fileName = 'upload.' + (ct.split('/')[1] || 'jpg');
        mimeType = ct;
      }
      
      // Generate unique key
      const key = Date.now() + '-' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      
      // Store in R2
      await HF_UPLOADS.put(key, fileData, {
        httpMetadata: { contentType: mimeType },
      });
      
      // Return public URL
      const publicUrl = 'https://hf-uploads.hectoflex.workers.dev/' + key;
      return json({ ok: true, url: publicUrl, key: key });
    }

    // === LIST UPLOADS ===
    if (path === '/uploads' && request.method === 'GET') {
      if (!user) return json({ error: 'Non autorisé' }, 401);
      const list = await HF_UPLOADS.list({ limit: 50 });
      const files = list.objects.map(o => ({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
        url: 'https://hf-uploads.hectoflex.workers.dev/' + o.key
      }));
      return json(files);
    }

    // === DELETE UPLOAD ===
    if (path.startsWith('/upload/') && request.method === 'DELETE') {
      if (!user) return json({ error: 'Non autorisé' }, 401);
      const key = path.replace('/upload/', '');
      await HF_UPLOADS.delete(key);
      return json({ ok: true });
    }


    // ==================== COMPTABILITÉ ====================

    // --- Compteurs (auto-increment) ---
    async function nextNumber(kv, type) {
      const key = 'compteurs:shared';
      const data = JSON.parse(await kv.get(key) || '{}');
      const year = new Date().getFullYear();
      const k = type + '_' + year;
      data[k] = (data[k] || 0) + 1;
      await kv.put(key, JSON.stringify(data));
      const prefix = type === 'devis' ? 'D' : type === 'facture' ? 'F' : 'C';
      return prefix + '-' + year + '-' + String(data[k]).padStart(3, '0');
    }

    // --- CLIENTS ---
    if (path === '/clients' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('clients:shared') || '[]');
      return json(data);
    }
    if (path === '/clients' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('clients:shared') || '[]');
      const client = {
        id: Date.now(),
        numero: await nextNumber(HF_TASKS, 'client'),
        nom: body.nom || '',
        contact: body.contact || '',
        email: body.email || '',
        telephone: body.telephone || '',
        adresse: body.adresse || '',
        npa: body.npa || '',
        ville: body.ville || '',
        pays: body.pays || 'Suisse',
        langue: body.langue || 'fr',
        conditions_paiement: body.conditions_paiement || '30 jours net',
        notes: body.notes || '',
        created_at: new Date().toISOString(),
        created_by: user
      };
      data.push(client);
      await HF_TASKS.put('clients:shared', JSON.stringify(data));
      return json(client, 201);
    }
    if (path.match(/^\/clients\/(\d+)$/) && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('clients:shared') || '[]');
      const idx = data.findIndex(c => c.id === id);
      if (idx < 0) return json({ error: 'Client not found' }, 404);
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('clients:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (path.match(/^\/clients\/(\d+)$/) && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let data = JSON.parse(await HF_TASKS.get('clients:shared') || '[]');
      data = data.filter(c => c.id !== id);
      await HF_TASKS.put('clients:shared', JSON.stringify(data));
      return json({ ok: true });
    }

    // --- DEVIS ---
    if (path === '/devis' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('devis:shared') || '[]');
      return json(data);
    }
    if (path === '/devis' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('devis:shared') || '[]');
      const lignes = (body.lignes || []).map(l => ({
        description: l.description || '',
        quantite: parseFloat(l.quantite) || 1,
        unite: l.unite || '',
        note: l.note || '',
        prix_unitaire: parseFloat(l.prix_unitaire) || 0,
        rabais: parseFloat(l.rabais) || 0,
        sous_total: (parseFloat(l.quantite) || 1) * (parseFloat(l.prix_unitaire) || 0) * (1 - (parseFloat(l.rabais) || 0) / 100)
      }));
      const sous_total_ht = lignes.reduce((s, l) => s + l.sous_total, 0);
      const tva_taux = parseFloat(body.tva_taux) || 8.1;
      const rabais_global = parseFloat(body.rabais_pourcent) || 0;
      const ht_apres_rabais = sous_total_ht * (1 - rabais_global / 100);
      const tva_montant = ht_apres_rabais * tva_taux / 100;
      const total_ttc = ht_apres_rabais + tva_montant;

      const devis = {
        id: Date.now(),
        numero: await nextNumber(HF_TASKS, 'devis'),
        client_id: body.client_id || null,
        client_name: body.client_name || '',
        client_adresse: body.client_adresse || '',
        client_email: body.client_email || '',
        date: body.date || new Date().toISOString().slice(0, 10),
        validite: body.validite || '',
        statut: 'brouillon',
        lignes,
        sous_total_ht: Math.round(sous_total_ht * 100) / 100,
        rabais_pourcent: rabais_global,
        ht_apres_rabais: Math.round(ht_apres_rabais * 100) / 100,
        tva_taux,
        tva_montant: Math.round(tva_montant * 100) / 100,
        total_ttc: Math.round(total_ttc * 100) / 100,
        conditions: body.conditions || '30 jours net',
        notes: body.notes || '',
        created_at: new Date().toISOString(),
        created_by: user
      };
      data.push(devis);
      await HF_TASKS.put('devis:shared', JSON.stringify(data));
      return json(devis, 201);
    }
    if (path.match(/^\/devis\/(\d+)$/) && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('devis:shared') || '[]');
      const idx = data.findIndex(d => d.id === id);
      if (idx < 0) return json({ error: 'Devis not found' }, 404);

      // Recalculate if lines changed
      if (body.lignes) {
        body.lignes = body.lignes.map(l => ({
          description: l.description || '',
          quantite: parseFloat(l.quantite) || 1,
          unite: l.unite || '',
          note: l.note || '',
          prix_unitaire: parseFloat(l.prix_unitaire) || 0,
          rabais: parseFloat(l.rabais) || 0,
          sous_total: (parseFloat(l.quantite) || 1) * (parseFloat(l.prix_unitaire) || 0) * (1 - (parseFloat(l.rabais) || 0) / 100)
        }));
        const sous_total_ht = body.lignes.reduce((s, l) => s + l.sous_total, 0);
        const rabais = parseFloat(body.rabais_pourcent ?? data[idx].rabais_pourcent) || 0;
        const ht_apres_rabais = sous_total_ht * (1 - rabais / 100);
        const tva = parseFloat(body.tva_taux ?? data[idx].tva_taux) || 8.1;
        body.sous_total_ht = Math.round(sous_total_ht * 100) / 100;
        body.ht_apres_rabais = Math.round(ht_apres_rabais * 100) / 100;
        body.tva_montant = Math.round(ht_apres_rabais * tva / 100 * 100) / 100;
        body.total_ttc = Math.round((ht_apres_rabais + ht_apres_rabais * tva / 100) * 100) / 100;
      }
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('devis:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (path.match(/^\/devis\/(\d+)$/) && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let data = JSON.parse(await HF_TASKS.get('devis:shared') || '[]');
      const d = data.find(x => x.id === id);
      if (d && d.statut !== 'brouillon') return json({ error: 'Seuls les brouillons peuvent être supprimés' }, 400);
      data = data.filter(x => x.id !== id);
      await HF_TASKS.put('devis:shared', JSON.stringify(data));
      return json({ ok: true });
    }
    // Convert devis to facture
    if (path.match(/^\/devis\/(\d+)\/invoice$/) && request.method === 'POST') {
      const id = parseInt(path.split('/')[2]);
      const devisData = JSON.parse(await HF_TASKS.get('devis:shared') || '[]');
      const dIdx = devisData.findIndex(d => d.id === id);
      if (dIdx < 0) return json({ error: 'Devis not found' }, 404);
      const d = devisData[dIdx];
      if (d.statut === 'facture') return json({ error: 'Déjà converti en facture' }, 400);

      // Create facture from devis
      const factures = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      const facture = {
        id: Date.now(),
        numero: await nextNumber(HF_TASKS, 'facture'),
        devis_id: d.id,
        devis_numero: d.numero,
        client_id: d.client_id,
        client_name: d.client_name,
        client_adresse: d.client_adresse,
        client_email: d.client_email,
        date_facture: new Date().toISOString().slice(0, 10),
        date_echeance: '',
        statut: 'brouillon',
        lignes: JSON.parse(JSON.stringify(d.lignes)),
        sous_total_ht: d.sous_total_ht,
        rabais_pourcent: d.rabais_pourcent,
        ht_apres_rabais: d.ht_apres_rabais,
        tva_taux: d.tva_taux,
        tva_montant: d.tva_montant,
        total_ttc: d.total_ttc,
        montant_paye: 0,
        reste_a_payer: d.total_ttc,
        conditions: d.conditions,
        notes: d.notes,
        narration: '',
        rappels_envoyes: 0,
        created_at: new Date().toISOString(),
        created_by: user
      };
      factures.push(facture);
      await HF_TASKS.put('factures:shared', JSON.stringify(factures));

      // Update devis status
      devisData[dIdx].statut = 'facture';
      devisData[dIdx].facture_id = facture.id;
      await HF_TASKS.put('devis:shared', JSON.stringify(devisData));

      return json(facture, 201);
    }

    // --- FACTURES ---
    if (path === '/factures' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      return json(data);
    }
    if (path === '/factures' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      const lignes = (body.lignes || []).map(l => ({
        description: l.description || '',
        quantite: parseFloat(l.quantite) || 1,
        unite: l.unite || '',
        note: l.note || '',
        prix_unitaire: parseFloat(l.prix_unitaire) || 0,
        rabais: parseFloat(l.rabais) || 0,
        sous_total: (parseFloat(l.quantite) || 1) * (parseFloat(l.prix_unitaire) || 0) * (1 - (parseFloat(l.rabais) || 0) / 100)
      }));
      const sous_total_ht = lignes.reduce((s, l) => s + l.sous_total, 0);
      const rabais = parseFloat(body.rabais_pourcent) || 0;
      const ht_apres_rabais = sous_total_ht * (1 - rabais / 100);
      const tva_taux = parseFloat(body.tva_taux) || 8.1;
      const tva_montant = ht_apres_rabais * tva_taux / 100;
      const total_ttc = ht_apres_rabais + tva_montant;

      const facture = {
        id: Date.now(),
        numero: await nextNumber(HF_TASKS, 'facture'),
        devis_id: body.devis_id || null,
        client_id: body.client_id || null,
        client_name: body.client_name || '',
        client_adresse: body.client_adresse || '',
        client_email: body.client_email || '',
        date_facture: body.date_facture || new Date().toISOString().slice(0, 10),
        date_echeance: body.date_echeance || '',
        statut: 'brouillon',
        lignes,
        sous_total_ht: Math.round(sous_total_ht * 100) / 100,
        rabais_pourcent: rabais,
        ht_apres_rabais: Math.round(ht_apres_rabais * 100) / 100,
        tva_taux,
        tva_montant: Math.round(tva_montant * 100) / 100,
        total_ttc: Math.round(total_ttc * 100) / 100,
        montant_paye: 0,
        reste_a_payer: Math.round(total_ttc * 100) / 100,
        conditions: body.conditions || '30 jours net',
        notes: body.notes || '',
        narration: body.narration || '',
        rappels_envoyes: 0,
        created_at: new Date().toISOString(),
        created_by: user
      };
      data.push(facture);
      await HF_TASKS.put('factures:shared', JSON.stringify(data));
      return json(facture, 201);
    }
    if (path.match(/^\/factures\/(\d+)$/) && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      const idx = data.findIndex(f => f.id === id);
      if (idx < 0) return json({ error: 'Facture not found' }, 404);

      if (body.lignes) {
        body.lignes = body.lignes.map(l => ({
          description: l.description || '',
          quantite: parseFloat(l.quantite) || 1,
          unite: l.unite || '',
          note: l.note || '',
          prix_unitaire: parseFloat(l.prix_unitaire) || 0,
          rabais: parseFloat(l.rabais) || 0,
          sous_total: (parseFloat(l.quantite) || 1) * (parseFloat(l.prix_unitaire) || 0) * (1 - (parseFloat(l.rabais) || 0) / 100)
        }));
        const sht = body.lignes.reduce((s, l) => s + l.sous_total, 0);
        const rab = parseFloat(body.rabais_pourcent ?? data[idx].rabais_pourcent) || 0;
        const har = sht * (1 - rab / 100);
        const tv = parseFloat(body.tva_taux ?? data[idx].tva_taux) || 8.1;
        const tvm = har * tv / 100;
        body.sous_total_ht = Math.round(sht * 100) / 100;
        body.ht_apres_rabais = Math.round(har * 100) / 100;
        body.tva_montant = Math.round(tvm * 100) / 100;
        body.total_ttc = Math.round((har + tvm) * 100) / 100;
        body.reste_a_payer = Math.round((har + tvm - (data[idx].montant_paye || 0)) * 100) / 100;
      }
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('factures:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (path.match(/^\/factures\/(\d+)$/) && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let data = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      const f = data.find(x => x.id === id);
      if (f && f.statut !== 'brouillon') return json({ error: 'Seuls les brouillons peuvent être supprimés' }, 400);
      data = data.filter(x => x.id !== id);
      await HF_TASKS.put('factures:shared', JSON.stringify(data));
      return json({ ok: true });
    }
    // Register payment on facture
    if (path.match(/^\/factures\/(\d+)\/pay$/) && request.method === 'POST') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factures:shared') || '[]');
      const idx = data.findIndex(f => f.id === id);
      if (idx < 0) return json({ error: 'Facture not found' }, 404);

      const montant = parseFloat(body.montant) || 0;
      data[idx].montant_paye = Math.round(((data[idx].montant_paye || 0) + montant) * 100) / 100;
      data[idx].reste_a_payer = Math.round((data[idx].total_ttc - data[idx].montant_paye) * 100) / 100;
      if (data[idx].reste_a_payer <= 0) {
        data[idx].statut = 'payee';
        data[idx].reste_a_payer = 0;
      }

      // Save payment record
      const paiements = JSON.parse(await HF_TASKS.get('paiements:shared') || '[]');
      paiements.push({
        id: Date.now(),
        facture_id: id,
        facture_numero: data[idx].numero,
        client_name: data[idx].client_name,
        montant,
        date: body.date || new Date().toISOString().slice(0, 10),
        methode: body.methode || 'virement',
        reference: body.reference || '',
        notes: body.notes || '',
        created_at: new Date().toISOString(),
        created_by: user
      });
      await HF_TASKS.put('paiements:shared', JSON.stringify(paiements));
      await HF_TASKS.put('factures:shared', JSON.stringify(data));
      return json(data[idx]);
    }

    // --- PAIEMENTS ---
    if (path === '/paiements' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('paiements:shared') || '[]');
      return json(data);
    }


    // ===== FACTURES FOURNISSEURS =====
    if (path === '/factures-fournisseurs' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('factfourn:shared') || '[]');
      return json(data);
    }
    if (path === '/factures-fournisseurs' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factfourn:shared') || '[]');
      const item = { id: Date.now(), ...body, created_at: new Date().toISOString(), created_by: user };
      data.push(item);
      await HF_TASKS.put('factfourn:shared', JSON.stringify(data));
      return json(item, 201);
    }
    if (path.match(/^\/factures-fournisseurs\/(\d+)$/) && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factfourn:shared') || '[]');
      const idx = data.findIndex(f => f.id === id);
      if (idx < 0) return json({ error: 'Not found' }, 404);
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('factfourn:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (path.match(/^\/factures-fournisseurs\/(\d+)$/) && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let data = JSON.parse(await HF_TASKS.get('factfourn:shared') || '[]');
      data = data.filter(f => f.id !== id);
      await HF_TASKS.put('factfourn:shared', JSON.stringify(data));
      return json({ ok: true });
    }
    if (path.match(/^\/factures-fournisseurs\/(\d+)\/pay$/) && request.method === 'POST') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('factfourn:shared') || '[]');
      const idx = data.findIndex(f => f.id === id);
      if (idx < 0) return json({ error: 'Not found' }, 404);
      data[idx].statut = 'payee';
      data[idx].date_paiement = body.date || new Date().toISOString().slice(0, 10);
      data[idx].methode_paiement = body.methode || 'virement';
      await HF_TASKS.put('factfourn:shared', JSON.stringify(data));
      return json(data[idx]);
    }

    // ===== PLAN COMPTABLE =====
    if (path === '/plan-comptable' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('plancomptable:shared') || '[]');
      if (!data.length) {
        // Default Swiss SME plan
        const defaults = [
          {numero:'1000',libelle:'Caisse'},{numero:'1020',libelle:'Banque'},
          {numero:'1100',libelle:'Débiteurs'},{numero:'2000',libelle:'Créanciers'},
          {numero:'2200',libelle:'TVA due'},{numero:'3000',libelle:'Ventes marchandises'},
          {numero:'3001',libelle:'Ventes Textiles'},{numero:'3002',libelle:'Ventes Céramique'},
          {numero:'3003',libelle:'Ventes Véhicules'},{numero:'3004',libelle:'Ventes Panneaux'},
          {numero:'3005',libelle:'Ventes Stickers'},{numero:'3006',libelle:'Ventes Bâches'},
          {numero:'3007',libelle:'Ventes Vitrophanie'},{numero:'3008',libelle:'Ventes Covering'},
          {numero:'3009',libelle:'Ventes Pose'},{numero:'3010',libelle:'Ventes Design'},
          {numero:'3011',libelle:'Ventes Impression'},{numero:'4000',libelle:'Achats marchandises'},
          {numero:'4400',libelle:'Achats fournitures'},{numero:'5000',libelle:'Salaires'},
          {numero:'6000',libelle:'Loyer'},{numero:'6500',libelle:'Assurances'},
          {numero:'6800',libelle:'Amortissements'}
        ];
        return json(defaults);
      }
      return json(data);
    }
    if (path === '/plan-comptable' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('plancomptable:shared') || '[]');
      data.push({ id: Date.now(), numero: body.numero || '', libelle: body.libelle || '' });
      await HF_TASKS.put('plancomptable:shared', JSON.stringify(data));
      return json(data);
    }

    // ===== DTF ORDERS (KV-backed) =====
    if (path === '/dtf/stats' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('dtf:orders') || '[]');
      const total = data.length;
      const traite = data.filter(o => o.traite).length;
      return json({ total, non_traite: total - traite, traite });
    }
    if (path === '/dtf/orders' && request.method === 'GET') {
      let data = JSON.parse(await HF_TASKS.get('dtf:orders') || '[]');
      const traiteParam = url.searchParams.get('traite');
      if (traiteParam === 'true') data = data.filter(o => o.traite);
      if (traiteParam === 'false') data = data.filter(o => !o.traite);
      const limit = parseInt(url.searchParams.get('limit')) || 200;
      return json(data.slice(0, limit));
    }
    if (path === '/dtf/orders' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('dtf:orders') || '[]');
      const order = { id: Date.now(), traite: false, ...body, created_at: new Date().toISOString(), created_by: user };
      data.unshift(order);
      await HF_TASKS.put('dtf:orders', JSON.stringify(data));
      return json(order, 201);
    }
    if (path.match(/^\/dtf\/orders\/(\d+)$/) && request.method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      const data = JSON.parse(await HF_TASKS.get('dtf:orders') || '[]');
      const order = data.find(o => o.id === id);
      if (!order) return json({ error: 'Not found' }, 404);
      return json(order);
    }
    if (path.match(/^\/dtf\/orders\/(\d+)$/) && (request.method === 'PUT' || request.method === 'PATCH')) {
      const id = parseInt(path.split('/')[3]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('dtf:orders') || '[]');
      const idx = data.findIndex(o => o.id === id);
      if (idx < 0) return json({ error: 'Not found' }, 404);
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('dtf:orders', JSON.stringify(data));
      return json(data[idx]);
    }

    // ===== PLANNING =====
    if (path === '/planning' && request.method === 'GET') {
      const data = JSON.parse(await HF_TASKS.get('planning:shared') || '[]');
      return json(data);
    }
    if (path === '/planning' && request.method === 'POST') {
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('planning:shared') || '[]');
      const event = { id: Date.now(), ...body, created_at: new Date().toISOString(), created_by: user };
      data.push(event);
      await HF_TASKS.put('planning:shared', JSON.stringify(data));
      return json(event, 201);
    }
    if (path.match(/^\/planning\/(\d+)$/) && request.method === 'PUT') {
      const id = parseInt(path.split('/')[2]);
      const body = await request.json();
      const data = JSON.parse(await HF_TASKS.get('planning:shared') || '[]');
      const idx = data.findIndex(e => e.id === id);
      if (idx < 0) return json({ error: 'Not found' }, 404);
      Object.assign(data[idx], body, { updated_at: new Date().toISOString() });
      await HF_TASKS.put('planning:shared', JSON.stringify(data));
      return json(data[idx]);
    }
    if (path.match(/^\/planning\/(\d+)$/) && request.method === 'DELETE') {
      const id = parseInt(path.split('/')[2]);
      let data = JSON.parse(await HF_TASKS.get('planning:shared') || '[]');
      data = data.filter(e => e.id !== id);
      await HF_TASKS.put('planning:shared', JSON.stringify(data));
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  }
};
