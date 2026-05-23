// 3D 模型查看器 - Netlify Functions API
// 基于 Netlify Blobs 的云端存储后端

import { getStore } from "@netlify/blobs";

// Blob 存储实例
const STORE = getStore("3d-viewer");

// CORS 头
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// —— 路由匹配工具 ——
const ROUTES = [
  // GET /api/ping — 健康检查，不依赖 blobs
  [/^\/api\/ping\/?$/, "GET", "ping"],
  // GET /api/projects
  [/^\/api\/projects\/?$/, "GET", "listProjects"],
  // POST /api/projects
  [/^\/api\/projects\/?$/, "POST", "createProject"],
  // PUT /api/projects/:id
  [/^\/api\/projects\/([^/]+)\/?$/, "PUT", "updateProject"],
  // DELETE /api/projects/:id
  [/^\/api\/projects\/([^/]+)\/?$/, "DELETE", "deleteProject"],
  // GET /api/models/:projectId
  [/^\/api\/models\/([^/]+)\/?$/, "GET", "listModels"],
  // POST /api/models
  [/^\/api\/models\/?$/, "POST", "uploadModel"],
  // DELETE /api/models/:modelId
  [/^\/api\/models\/([^/]+)\/?$/, "DELETE", "deleteModel"],
  // GET /api/model-data/:modelId
  [/^\/api\/model-data\/([^/]+)\/?$/, "GET", "getModelData"],
];

function matchRoute(method, pathname) {
  for (const [pattern, m, handler] of ROUTES) {
    if (method !== m) continue;
    const match = pathname.match(pattern);
    if (match) return { handler, params: match.slice(1) };
  }
  return null;
}

// —— 响应工具 ——
function json(data, status = 200) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function bin(data, contentType = "application/octet-stream") {
  return new Response(data, {
    headers: {
      ...CORS,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function generateId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 11)
  );
}

// —— 健康检查（不依赖 blobs） ——
async function ping() {
  return json({ ok: true, time: new Date().toISOString() });
}

// —— 项目操作 ——
async function listProjects() {
  try {
    const data = await STORE.get("projects", { type: "json" });
    return json(data || []);
  } catch (e) {
    console.error("listProjects:", e);
    return json([]);
  }
}

async function createProject(body) {
  if (!body || !body.name) return error("缺少项目名称");
  const project = {
    id: body.id || generateId(),
    name: body.name,
    type: body.type || "db",
    createdAt: body.createdAt || new Date().toISOString(),
    folderHandleId: body.folderHandleId || null,
  };
  const projects = (await STORE.get("projects", { type: "json" })) || [];
  projects.push(project);
  await STORE.set("projects", JSON.stringify(projects));
  return json(project, 201);
}

async function updateProject(id, body) {
  const projects = (await STORE.get("projects", { type: "json" })) || [];
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return error("项目不存在", 404);

  projects[idx] = { ...projects[idx], ...body, id }; // 确保 id 不变
  await STORE.set("projects", JSON.stringify(projects));
  return json(projects[idx]);
}

async function deleteProject(id) {
  let projects = (await STORE.get("projects", { type: "json" })) || [];
  projects = projects.filter((p) => p.id !== id);
  await STORE.set("projects", JSON.stringify(projects));

  // 删除该项目的所有模型数据和元数据
  const modelsKey = `models:${id}`;
  const models = (await STORE.get(modelsKey, { type: "json" })) || [];
  const deletions = models.map((m) =>
    STORE.delete(`model-data:${m.id}`).catch(() => {})
  );
  deletions.push(STORE.delete(modelsKey));
  await Promise.all(deletions);

  return json({ ok: true });
}

// —— 模型操作 ——
async function listModels(projectId) {
  try {
    const data = await STORE.get(`models:${projectId}`, { type: "json" });
    // 返回元数据，不包含二进制数据
    const models = (data || []).map(({ data, ...meta }) => meta);
    return json(models);
  } catch (e) {
    console.error("listModels:", e);
    return json([]);
  }
}

async function uploadModel(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return error("请求格式错误，需要 multipart/form-data");
  }

  const projectId = formData.get("projectId");
  const file = formData.get("file");
  const modelId = formData.get("id") || generateId();

  if (!projectId) return error("缺少 projectId");
  if (!file || typeof file === "string") return error("缺少文件");

  const buffer = await file.arrayBuffer();
  const format = file.name.split(".").pop().toLowerCase();

  // 构建元数据
  const modelMeta = {
    id: modelId,
    projectId,
    name: file.name,
    format,
    size: file.size,
    isLocal: false,
    uploadedAt: new Date().toISOString(),
  };

  // 写入二进制数据和元数据
  await Promise.all([
    STORE.set(`model-data:${modelId}`, new Uint8Array(buffer)),
    (async () => {
      const modelsKey = `models:${projectId}`;
      const models =
        (await STORE.get(modelsKey, { type: "json" })) || [];
      models.push(modelMeta);
      await STORE.set(modelsKey, JSON.stringify(models));
    })(),
  ]);

  return json(modelMeta, 201);
}

async function deleteModel(modelId) {
  // 遍历所有项目找到该模型
  const projects = (await STORE.get("projects", { type: "json" })) || [];
  let found = false;
  for (const p of projects) {
    const modelsKey = `models:${p.id}`;
    const models = (await STORE.get(modelsKey, { type: "json" })) || [];
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx !== -1) {
      models.splice(idx, 1);
      await STORE.set(modelsKey, JSON.stringify(models));
      found = true;
      break;
    }
  }

  await STORE.delete(`model-data:${modelId}`).catch(() => {});

  return json({ ok: true, found });
}

async function getModelData(modelId) {
  try {
    const data = await STORE.get(`model-data:${modelId}`, {
      type: "arrayBuffer",
    });
    if (!data) {
      return json({ error: "模型数据不存在" }, 404);
    }
    return bin(data);
  } catch (e) {
    console.error("getModelData:", e);
    return error("获取模型数据失败", 500);
  }
}

// —— 主入口 ——
export default async function handler(request) {
  try {
    return await handleRequest(request);
  } catch (e) {
    console.error("[api] Fatal:", e.message, e.stack);
    return error("服务端错误: " + (e.message || "unknown"), 500);
  }
}

async function handleRequest(request) {
  // 预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  // 兼容 Netlify 重写后的路径：
  //   原始路径 /api/projects → 重写后可能是 /.netlify/functions/api/projects
  let pathname = url.pathname;
  if (pathname.startsWith("/.netlify/functions/api")) {
    pathname = pathname.replace("/.netlify/functions/api", "/api");
  }
  // 也兼容不带 /api 前缀的：/models/xxx → /api/models/xxx
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/api")) {
    pathname = "/api" + pathname;
  }

  const route = matchRoute(request.method, pathname);

  if (!route) {
    return error(
      `Not found: ${request.method} ${url.pathname}`,
      404
    );
  }

  try {
    const { handler: name, params } = route;

    switch (name) {
      case "ping":
        return await ping();

      case "listProjects":
        return await listProjects();

      case "createProject":
        return await createProject(await request.json().catch(() => null));

      case "updateProject":
        return await updateProject(
          params[0],
          await request.json().catch(() => null)
        );

      case "deleteProject":
        return await deleteProject(params[0]);

      case "listModels":
        return await listModels(params[0]);

      case "uploadModel":
        return await uploadModel(request);

      case "deleteModel":
        return await deleteModel(params[0]);

      case "getModelData":
        return await getModelData(params[0]);

      default:
        return error("未知操作", 500);
    }
  } catch (e) {
    console.error(`[api] ${name}:`, e);
    return error(`服务端错误: ${e.message}`, 500);
  }
}
