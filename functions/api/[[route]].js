// 3D 模型查看器 - Cloudflare Pages Functions
// Worker KV 存储后端
// 路由：/api/ping, /api/projects, /api/models, /api/model-data

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function bin(data, contentType = "application/octet-stream") {
  return new Response(data, {
    headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "public, max-age=31536000" },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function gid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

// —— KV 操作 ——
const KV = {
  get: (env, key, type) => env.STORE.get(key, type || "text"),
  put: (env, key, value) => env.STORE.put(key, value),
  del: (env, key) => env.STORE.delete(key),
};

// —— Projects ——
async function listProjects(env) {
  try {
    const raw = await KV.get(env, "projects", "json");
    return json(raw || []);
  } catch (e) {
    return json([]);
  }
}

async function createProject(env, body) {
  if (!body || !body.name) return err("缺少项目名称");
  const project = {
    id: body.id || gid(),
    name: body.name,
    type: body.type || "db",
    createdAt: body.createdAt || new Date().toISOString(),
    folderHandleId: body.folderHandleId || null,
  };
  const projects = (await KV.get(env, "projects", "json")) || [];
  projects.push(project);
  await KV.put(env, "projects", JSON.stringify(projects));
  return json(project, 201);
}

async function updateProject(env, id, body) {
  const projects = (await KV.get(env, "projects", "json")) || [];
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return err("项目不存在", 404);
  projects[idx] = { ...projects[idx], ...body, id };
  await KV.put(env, "projects", JSON.stringify(projects));
  return json(projects[idx]);
}

async function deleteProject(env, id) {
  let projects = (await KV.get(env, "projects", "json")) || [];
  projects = projects.filter((p) => p.id !== id);
  await KV.put(env, "projects", JSON.stringify(projects));

  // 删除该项目的所有模型
  const models = (await KV.get(env, `models:${id}`, "json")) || [];
  for (const m of models) {
    await KV.del(env, `model-data:${m.id}`);
  }
  await KV.del(env, `models:${id}`);
  return json({ ok: true });
}

// —— Models ——
async function listModels(env, projectId) {
  try {
    const raw = await KV.get(env, `models:${projectId}`, "json");
    const models = (raw || []).map(({ data, ...meta }) => meta);
    return json(models);
  } catch (e) {
    return json([]);
  }
}

async function uploadModel(env, request) {
  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return err("请求格式错误，需要 multipart/form-data");
  }

  const projectId = formData.get("projectId");
  const file = formData.get("file");
  const modelId = formData.get("id") || gid();

  if (!projectId) return err("缺少 projectId");
  if (!file || typeof file === "string") return err("缺少文件");

  const buffer = await file.arrayBuffer();
  const format = file.name.split(".").pop().toLowerCase();

  const modelMeta = {
    id: modelId,
    projectId,
    name: file.name,
    format,
    size: file.size,
    isLocal: false,
    uploadedAt: new Date().toISOString(),
  };

  // 写入元数据和二进制
  const modelsKey = `models:${projectId}`;
  const models = (await KV.get(env, modelsKey, "json")) || [];
  models.push(modelMeta);

  await Promise.all([
    KV.put(env, `model-data:${modelId}`, buffer),
    KV.put(env, modelsKey, JSON.stringify(models)),
  ]);

  return json(modelMeta, 201);
}

async function deleteModel(env, modelId) {
  const projects = (await KV.get(env, "projects", "json")) || [];
  let found = false;
  for (const p of projects) {
    const modelsKey = `models:${p.id}`;
    const models = (await KV.get(env, modelsKey, "json")) || [];
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx !== -1) {
      models.splice(idx, 1);
      await KV.put(env, modelsKey, JSON.stringify(models));
      found = true;
      break;
    }
  }
  await KV.del(env, `model-data:${modelId}`);
  return json({ ok: true, found });
}

async function getModelData(env, modelId) {
  try {
    const data = await KV.get(env, `model-data:${modelId}`, "arrayBuffer");
    if (!data) return json({ error: "模型数据不存在" }, 404);
    return bin(data);
  } catch (e) {
    return err("获取模型数据失败", 500);
  }
}

// —— 主入口 ——
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // GET /api/ping
    if (path === "/api/ping" && request.method === "GET") {
      return json({ ok: true, time: new Date().toISOString() });
    }
    // GET /api/projects
    if (path === "/api/projects" && request.method === "GET") {
      return listProjects(env);
    }
    // POST /api/projects
    if (path === "/api/projects" && request.method === "POST") {
      return createProject(env, await request.json().catch(() => null));
    }
    // PUT /api/projects/:id
    if (path.match(/^\/api\/projects\/([^/]+)$/) && request.method === "PUT") {
      const id = path.split("/")[3];
      return updateProject(env, id, await request.json().catch(() => null));
    }
    // DELETE /api/projects/:id
    if (path.match(/^\/api\/projects\/([^/]+)$/) && request.method === "DELETE") {
      return deleteProject(env, path.split("/")[3]);
    }
    // GET /api/models/:projectId
    if (path.match(/^\/api\/models\/([^/]+)$/) && request.method === "GET") {
      return listModels(env, path.split("/")[3]);
    }
    // POST /api/models
    if (path === "/api/models" && request.method === "POST") {
      return uploadModel(env, request);
    }
    // DELETE /api/models/:modelId
    if (path.match(/^\/api\/models\/([^/]+)$/) && request.method === "DELETE") {
      return deleteModel(env, path.split("/")[3]);
    }
    // GET /api/model-data/:modelId
    if (path.match(/^\/api\/model-data\/([^/]+)$/) && request.method === "GET") {
      return getModelData(env, path.split("/")[3]);
    }

    return err(`Not found: ${request.method} ${path}`, 404);
  } catch (e) {
    console.error("[api]", e.message);
    return err(`服务端错误: ${e.message}`, 500);
  }
}
