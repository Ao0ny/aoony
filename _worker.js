// 3D 模型查看器 - Cloudflare Pages Worker
// Worker KV 存储后端

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function bin(data, ct = "application/octet-stream") {
  return new Response(data, { headers: { ...CORS, "Content-Type": ct, "Cache-Control": "public, max-age=31536000" } });
}

function err(msg, status = 400) { return json({ error: msg }, status); }
function gid() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 11); }

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    // 只处理 /api/* 请求，其余交给静态资源
    if (!p.startsWith("/api/")) {
      // 不是 API 请求，用 Pages 默认行为处理
      return env.ASSETS.fetch(request);
    }

    try {
      if (p === "/api/ping" && request.method === "GET") {
        return json({ ok: true, time: new Date().toISOString() });
      }

      // Projects
      if (p === "/api/projects" && request.method === "GET") {
        const data = (await env.STORE.get("projects", "json")) || [];
        return json(data);
      }
      if (p === "/api/projects" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.name) return err("缺少项目名称");
        const proj = { id: body.id || gid(), name: body.name, type: body.type || "db", createdAt: body.createdAt || new Date().toISOString(), folderHandleId: body.folderHandleId || null };
        const projects = (await env.STORE.get("projects", "json")) || [];
        projects.push(proj);
        await env.STORE.put("projects", JSON.stringify(projects));
        return json(proj, 201);
      }
      if (p.match(/^\/api\/projects\/([^/]+)$/) && request.method === "PUT") {
        const id = p.split("/")[3];
        const body = await request.json().catch(() => null);
        const projects = (await env.STORE.get("projects", "json")) || [];
        const idx = projects.findIndex(x => x.id === id);
        if (idx === -1) return err("项目不存在", 404);
        projects[idx] = { ...projects[idx], ...body, id };
        await env.STORE.put("projects", JSON.stringify(projects));
        return json(projects[idx]);
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

      // Models
      if (p.match(/^\/api\/models\/([^/]+)$/) && request.method === "GET") {
        const pid = p.split("/")[3];
        const models = (await env.STORE.get(`models:${pid}`, "json")) || [];
        return json(models.map(({ data, ...m }) => m));
      }
      if (p === "/api/models" && request.method === "POST") {
        let fd;
        try { fd = await request.formData(); } catch { return err("需要 multipart/form-data"); }
        const projectId = fd.get("projectId"), file = fd.get("file"), modelId = fd.get("id") || gid();
        if (!projectId) return err("缺少 projectId");
        if (!file || typeof file === "string") return err("缺少文件");
        const buf = await file.arrayBuffer(), fmt = file.name.split(".").pop().toLowerCase();
        const meta = { id: modelId, projectId, name: file.name, format: fmt, size: file.size, isLocal: false, uploadedAt: new Date().toISOString() };
        const mk = `models:${projectId}`;
        const models = (await env.STORE.get(mk, "json")) || [];
        models.push(meta);
        await Promise.all([env.STORE.put(`model-data:${modelId}`, buf), env.STORE.put(mk, JSON.stringify(models))]);
        return json(meta, 201);
      }
      if (p.match(/^\/api\/models\/([^/]+)$/) && request.method === "DELETE") {
        const mid = p.split("/")[3];
        const projects = (await env.STORE.get("projects", "json")) || [];
        for (const proj of projects) {
          const mk = `models:${proj.id}`;
          const models = (await env.STORE.get(mk, "json")) || [];
          const idx = models.findIndex(m => m.id === mid);
          if (idx !== -1) { models.splice(idx, 1); await env.STORE.put(mk, JSON.stringify(models)); break; }
        }
        await env.STORE.delete(`model-data:${mid}`);
        return json({ ok: true });
      }
      if (p.match(/^\/api\/model-data\/([^/]+)$/) && request.method === "GET") {
        const data = await env.STORE.get(`model-data:${p.split("/")[3]}`, "arrayBuffer");
        if (!data) return err("模型不存在", 404);
        return bin(data);
      }

      return err(`Not found: ${request.method} ${p}`, 404);
    } catch (e) {
      console.error("[api]", e.message);
      return err("服务端错误: " + e.message, 500);
    }
  }
};
