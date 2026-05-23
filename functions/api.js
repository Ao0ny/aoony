// 3D 模型查看器 API - Cloudflare Pages Functions
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const p = url.pathname;

  function json(d, s = 200) {
    return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  }
  function err(m, s = 400) { return json({ error: m }, s); }
  function gid() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 11); }

  try {
    // 健康检查
    if (p === "/api/ping" && request.method === "GET") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // —— Projects ——
    if (p === "/api/projects" && request.method === "GET") {
      return json((await env.STORE.get("projects", "json")) || []);
    }
    if (p === "/api/projects" && request.method === "POST") {
      const b = await request.json().catch(() => null);
      if (!b || !b.name) return err("缺少项目名称");
      const proj = { id: b.id || gid(), name: b.name, type: b.type || "db", createdAt: b.createdAt || new Date().toISOString(), folderHandleId: b.folderHandleId || null };
      const projects = (await env.STORE.get("projects", "json")) || [];
      projects.push(proj);
      await env.STORE.put("projects", JSON.stringify(projects));
      return json(proj, 201);
    }
    if (p.match(/^\/api\/projects\/([^/]+)$/) && request.method === "PUT") {
      const id = p.split("/")[3], b = await request.json().catch(() => null);
      const projects = (await env.STORE.get("projects", "json")) || [];
      const i = projects.findIndex(x => x.id === id);
      if (i === -1) return err("项目不存在", 404);
      projects[i] = { ...projects[i], ...b, id };
      await env.STORE.put("projects", JSON.stringify(projects));
      return json(projects[i]);
    }
    if (p.match(/^\/api\/projects\/([^/]+)$/) && request.method === "DELETE") {
      const id = p.split("/")[3];
      let projects = (await env.STORE.get("projects", "json")) || [];
      projects = projects.filter(x => x.id !== id);
      await env.STORE.put("projects", JSON.stringify(projects));
      const models = (await env.STORE.get(`models:${id}`, "json")) || [];
      for (const m of models) await env.STORE.delete(`model-data:${m.id}`);
      await env.STORE.delete(`models:${id}`);
      return json({ ok: true });
    }

    // —— Models ——
    if (p.match(/^\/api\/models\/([^/]+)$/) && request.method === "GET") {
      const models = (await env.STORE.get(`models:${p.split("/")[3]}`, "json")) || [];
      return json(models.map(({ data, ...m }) => m));
    }
    if (p === "/api/models" && request.method === "POST") {
      let fd;
      try { fd = await request.formData(); } catch { return err("需要 multipart/form-data"); }
      const pid = fd.get("projectId"), file = fd.get("file"), mid = fd.get("id") || gid();
      if (!pid) return err("缺少 projectId");
      if (!file || typeof file === "string") return err("缺少文件");
      const buf = await file.arrayBuffer(), fmt = file.name.split(".").pop().toLowerCase();
      const meta = { id: mid, projectId: pid, name: file.name, format: fmt, size: file.size, isLocal: false, uploadedAt: new Date().toISOString() };
      const mk = `models:${pid}`;
      const models = (await env.STORE.get(mk, "json")) || [];
      models.push(meta);
      await Promise.all([env.STORE.put(`model-data:${mid}`, buf), env.STORE.put(mk, JSON.stringify(models))]);
      return json(meta, 201);
    }
    if (p.match(/^\/api\/models\/([^/]+)$/) && request.method === "DELETE") {
      const mid = p.split("/")[3];
      const projects = (await env.STORE.get("projects", "json")) || [];
      for (const proj of projects) {
        const mk = `models:${proj.id}`, models = (await env.STORE.get(mk, "json")) || [];
        const i = models.findIndex(m => m.id === mid);
        if (i !== -1) { models.splice(i, 1); await env.STORE.put(mk, JSON.stringify(models)); break; }
      }
      await env.STORE.delete(`model-data:${mid}`);
      return json({ ok: true });
    }
    if (p.match(/^\/api\/model-data\/([^/]+)$/) && request.method === "GET") {
      const data = await env.STORE.get(`model-data:${p.split("/")[3]}`, "arrayBuffer");
      if (!data) return err("模型不存在", 404);
      return new Response(data, { headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000" } });
    }

    return err(`Not found: ${request.method} ${p}`, 404);
  } catch (e) {
    console.error("[api]", e.message);
    return err("服务端错误: " + e.message, 500);
  }
}
